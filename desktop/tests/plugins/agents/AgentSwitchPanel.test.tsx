import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSwitchPanel,
  AgentSwitchSidebarStatus,
} from "../../../src/plugins/agents/ui/AgentSwitchPanel.tsx";
import { createAgentSwitchProgress } from "../../../src/plugins/agents/ui/agentSwitchProgress.ts";
import type { AgentSwitchProgressListener } from "../../../src/plugins/project/types.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import type { WorkbenchLayout } from "../../../src/plugins/workbench/types.ts";
import { createStore } from "zustand/vanilla";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const calls: {
    id: string;
    report?: AgentSwitchProgressListener;
    pending: ReturnType<typeof deferred>;
  }[] = [];
  const sessions = {
    switchAgent: (id: string, report?: AgentSwitchProgressListener) => {
      const pending = deferred();
      calls.push({ id, report, pending });
      return pending.promise;
    },
  };
  const agents = {
    selectedId: "old",
    resolve: (id?: string) => ({
      id,
      displayName: id === "old" ? "旧 Agent" : `Agent ${id}`,
    }),
  } as unknown as Pick<AgentsService, "resolve" | "selectedId">;
  return { calls, controller: createAgentSwitchProgress(sessions, agents) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agent 切换进度", () => {
  it("设置页隐藏侧边栏时提供浮动入口", async () => {
    const { controller, calls } = fixture();
    const navigation = createStore(() => ({
      sidebarCollapsed: false,
      overlay: "settings",
    }));
    render(
      <AgentSwitchPanel
        controller={controller}
        navigation={navigation as unknown as WorkbenchLayout["navigation"]}
      />,
    );
    let switching!: Promise<void>;
    act(() => {
      switching = controller.start("new");
    });
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    const indicator = screen.getByRole("button", { name: /Agent 切换状态/ });
    expect(indicator).toBeVisible();
    expect(indicator).toHaveTextContent("Agent new");
    fireEvent.click(indicator);
    expect(screen.getByLabelText("Agent 切换进度详情")).toBeVisible();
    await act(async () => {
      calls[0]!.pending.resolve();
      await switching;
    });
  });

  it("显示并行连接进度、慢步骤提示，可最小化并在成功后消失", async () => {
    vi.useFakeTimers();
    const { controller, calls } = fixture();
    render(
      <>
        <AgentSwitchSidebarStatus controller={controller} />
        <AgentSwitchPanel controller={controller} />
      </>,
    );
    let switching!: Promise<void>;
    act(() => {
      switching = controller.start("new");
    });
    act(() => {
      calls[0]!.report?.({ type: "stage", stage: "target" });
      for (let i = 0; i < 4; i++)
        calls[0]!.report?.({ type: "connection", event: { kind: "starting" } });
      calls[0]!.report?.({ type: "connection", event: { kind: "handshake" } });
      calls[0]!.report?.({ type: "connection", event: { kind: "ready" } });
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(/发起启动 4\/4/)).toHaveTextContent("握手完成 1/4");
    expect(screen.getByText(/当前步骤耗时较长/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(
      screen.queryByLabelText("Agent 切换进度详情"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Agent 切换状态/ }));
    expect(screen.getByLabelText("Agent 切换进度详情")).toBeVisible();
    await act(async () => {
      calls[0]!.pending.resolve();
      await switching;
    });
    expect(screen.getByText(/切换成功 · 总耗时/)).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByLabelText("Agent 切换状态")).not.toBeInTheDocument();
  });

  it("失败后保留原始步骤、复制时遮盖凭据，重试需要确认", async () => {
    const { controller, calls } = fixture();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<AgentSwitchPanel controller={controller} />);
    const afterRetry = vi.fn();
    let switching!: Promise<void>;
    act(() => {
      switching = controller.start("new", afterRetry).catch(() => {});
    });
    act(() => {
      calls[0]!.report?.({ type: "stage", stage: "commit" });
      calls[0]!.report?.({ type: "stopRequested", count: 2 });
      calls[0]!.report?.({ type: "failure", error: "token=secret-value" });
      calls[0]!.report?.({ type: "stage", stage: "rollback" });
    });
    await act(async () => {
      calls[0]!.pending.reject(new Error("token=secret-value"));
      await switching;
    });
    expect(screen.getByText("失败步骤：停止旧连接并切换连接池")).toBeVisible();
    expect(screen.getByText(/已向 2 个会话发出停止请求/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制诊断信息" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]![0]).toContain("token=[已隐藏]");
    expect(writeText.mock.calls[0]![0]).not.toContain("secret-value");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const confirm = screen.getByRole("dialog", { name: "重试切换 Agent 确认" });
    expect(calls).toHaveLength(1);
    fireEvent.click(within(confirm).getByRole("button", { name: "确认重试" }));
    expect(calls).toHaveLength(2);
    await act(async () => {
      calls[1]!.pending.resolve();
      await calls[1]!.pending.promise;
    });
    expect(afterRetry).toHaveBeenCalledOnce();
  });

  it("连续选择时忽略旧请求的事件和失败", async () => {
    const { controller, calls } = fixture();
    render(<AgentSwitchPanel controller={controller} />);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = controller.start("first").catch(() => {});
      second = controller.start("second");
    });
    act(() => {
      calls[0]!.report?.({ type: "stage", stage: "commit" });
    });
    await act(async () => {
      calls[0]!.pending.reject(new Error("旧错误"));
      await first;
    });
    expect(screen.getByText(/先前选择已被新请求替代/)).toBeVisible();
    expect(screen.queryByText("旧错误")).not.toBeInTheDocument();
    expect(controller.store.getState().current?.targetId).toBe("second");
    await act(async () => {
      calls[1]!.pending.resolve();
      await second;
    });
  });

  it("旧请求晚成功时不会执行旧请求的成功后动作", async () => {
    const { controller, calls } = fixture();
    const staleSuccess = vi.fn();
    const first = controller
      .start("first")
      .then(staleSuccess)
      .catch(() => {});
    const second = controller.start("second");
    calls[0]!.pending.resolve();
    await first;
    expect(staleSuccess).not.toHaveBeenCalled();
    expect(controller.store.getState().current?.targetId).toBe("second");
    calls[1]!.pending.resolve();
    await second;
  });
});
