import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSwitchPanel } from "../../../src/plugins/agents/ui/AgentSwitchPanel.tsx";
import { ModalShell } from "../../../src/shared/ui/ModalShell.tsx";
import { createAgentSwitchProgress } from "../../../src/plugins/agents/ui/agentSwitchProgress.ts";
import type { AgentSwitchProgressListener } from "../../../src/plugins/project/types.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";

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
  it("切换阻塞设置，失败后通过退出按钮返回设置", async () => {
    const { controller, calls } = fixture();
    const closeSettings = vi.fn();
    render(
      <>
        <ModalShell label="设置" size="settings" onDismiss={closeSettings}>
          <button type="button">Agent</button>
        </ModalShell>
        <AgentSwitchPanel controller={controller} />
      </>,
    );
    let switching!: Promise<void>;
    act(() => {
      switching = controller.start("new").catch(() => {});
    });
    const progress = screen.getByRole("dialog", { name: "Agent 切换进度" });
    expect(progress).toHaveFocus();
    fireEvent.keyDown(progress, { key: "Escape" });
    fireEvent.click(progress.parentElement!);
    expect(progress).toBeVisible();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(within(progress).queryByRole("button")).not.toBeInTheDocument();
    await act(async () => {
      calls[0]!.pending.reject(new Error("连接失败"));
      await switching;
    });
    expect(progress).toBeVisible();
    fireEvent.click(within(progress).getByRole("button", { name: "退出" }));
    expect(progress).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent" })).toHaveFocus();
  });

  it("显示并行连接进度、慢步骤提示，成功后等一秒关闭", async () => {
    vi.useFakeTimers();
    const { controller, calls } = fixture();
    render(<AgentSwitchPanel controller={controller} />);
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
    expect(screen.getByText(/发起启动 4/)).toHaveTextContent("握手完成 1");
    expect(screen.getByText(/当前步骤耗时较长/)).toBeVisible();
    await act(async () => {
      calls[0]!.pending.resolve();
      await switching;
    });
    expect(screen.getByText("切换成功")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(
      screen.getByRole("dialog", { name: "Agent 切换进度" }),
    ).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      screen.queryByRole("dialog", { name: "Agent 切换进度" }),
    ).not.toBeInTheDocument();
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
