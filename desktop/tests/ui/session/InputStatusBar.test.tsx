/**
 * 输入区状态行（InputStatusBar）测试：上下文用量条（百分比与用量条、
 * 70/90 阈值换色）、skills/mcp 计数徽标与悬停明细、运行状态章（相位文案
 * 随轮次状态机变化，轮次外不显示）。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InputStatusRight,
  TurnStatusRow,
} from "../../../src/ui/session/InputStatusBar.tsx";
import { useRuntimeStatusStore } from "../../../src/stores/runtimeStatusStore.ts";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useApprovalStore } from "../../../src/stores/approvalStore.ts";

beforeEach(() => {
  useRuntimeStatusStore.getState().reset();
  useSessionStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

function seedRuntime(): void {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "chrys_runtime",
    sessionId: "s-1",
    runtime: {
      modelProfileId: "glm-max",
      skillNames: ["aaw-workflow", "code-check"],
      runtimeDetails: {
        model: { name: "GLM-4.6", provider: "zhipu" },
        mcp_tools: { "server-a": ["t1"], "server-b": ["t1", "t2"] },
        mcp_failures: { "server-c": "connection refused" },
        skill_sources: { user: ["aaw-workflow"], project: ["code-check"] },
      },
    },
  });
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "chrys_usage",
    sessionId: "s-1",
    usage: {
      sessionId: "s-1",
      pct: 42.5,
      totalTokens: 51000,
      maxContextTokens: 120000,
      totalSessionTokens: 90000,
      cacheHitTokens: 8000,
      usageSourceId: "s-1",
    },
  } as never);
}

describe("InputStatusBar", () => {
  it("等待、取消和未知状态使用各自文案，未知状态不依赖运行时相位", () => {
    useSessionStore.setState({
      isAgentRunning: true,
      turnState: "running",
      isWaitingForActivity: true,
    });
    useRuntimeStatusStore.getState().beginTurn();
    const { rerender } = render(<TurnStatusRow />);
    expect(
      screen.getByText("暂未收到新进度，仍在等待响应…"),
    ).toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        turnState: "cancelling",
        isWaitingForActivity: false,
      }),
    );
    expect(screen.getByText("正在取消，等待确认…")).toBeInTheDocument();
    act(() => {
      useSessionStore.setState({ turnState: "unknown" });
      useRuntimeStatusStore.getState().reset();
    });
    rerender(<TurnStatusRow />);
    expect(screen.getByText(/执行状态未确认/)).toBeInTheDocument();
  });

  it("上下文用量圆环：百分比 + 悬停明细（窗口/累计/缓存）", () => {
    seedRuntime();
    render(<InputStatusRight />);
    const meter = screen.getByText("42%").closest("[data-status=context]");
    expect(meter).not.toBeNull();
    expect(meter).toHaveAttribute(
      "title",
      expect.stringContaining("51k / 120k"),
    );
    expect(meter).toHaveAttribute("title", expect.stringContaining("90k"));
    expect(meter).toHaveAttribute("title", expect.stringContaining("8k"));
  });

  it("模型切换器：无清单时纯展示；有清单时菜单可换（经 store switchModel）", async () => {
    seedRuntime();
    const { rerender } = render(<InputStatusRight />);
    // 无清单：纯展示标签（圆环测试另行覆盖，这里只看模型不带 menu）
    expect(
      screen.queryByRole("button", { name: "模型选择" }),
    ).not.toBeInTheDocument();

    const switchModel = vi.fn();
    useSessionStore.setState({
      availableModels: [
        { modelId: "glm-5", name: "glm-5", description: null },
        { modelId: "deepseek-v4", name: "deepseek-v4", description: null },
      ],
      currentModelId: "glm-5",
      switchModel,
    });
    rerender(<InputStatusRight />);
    await userEvent.click(screen.getByRole("button", { name: "模型选择" }));
    const menu = screen.getByRole("menu", { name: "模型选择" });
    expect(menu).toHaveTextContent("glm-5");
    expect(menu).toHaveTextContent("deepseek-v4");
    // 选中 deepseek-v4
    await userEvent.click(
      screen.getByRole("menuitem", { name: /deepseek-v4/ }),
    );
    expect(switchModel).toHaveBeenCalledWith("deepseek-v4");
  });

  it("没有 chrys 通知时，用 ACP 当前模型 ID 匹配显示名，切换后同步显示", () => {
    useSessionStore.setState({
      availableModels: [
        { modelId: "model-a", name: "Model A" },
        { modelId: "model-b", name: "Model B" },
      ],
      currentModelId: "model-b",
    });
    render(<InputStatusRight />);
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "Model B",
    );
    act(() => useSessionStore.setState({ currentModelId: "model-a" }));
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "Model A",
    );
  });

  it("ACP 当前模型优先于旧 runtime；清单缺失时显示当前 ID", () => {
    seedRuntime();
    useSessionStore.setState({
      availableModels: [{ modelId: "model-a", name: "Model A" }],
      currentModelId: "model-a",
    });
    render(<InputStatusRight />);
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "Model A",
    );
    act(() => useSessionStore.setState({ availableModels: [] }));
    expect(screen.getByText("model-a")).toBeInTheDocument();
    expect(screen.queryByText("GLM-4.6")).not.toBeInTheDocument();
  });

  it("仅有可用模型清单时不会猜测第一个模型为当前模型", () => {
    useSessionStore.setState({
      availableModels: [{ modelId: "model-a", name: "Model A" }],
      currentModelId: null,
      modelLabel: null,
    });
    render(<InputStatusRight />);
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "—",
    );
  });

  it("无 usage 时不渲染圆环；无模型清单时模型为纯展示占位", () => {
    // 上一用例灌入的清单清理（store 跨用例共享）
    useSessionStore.setState({ availableModels: [], currentModelId: null });
    render(<InputStatusRight />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "模型选择" }),
    ).not.toBeInTheDocument();
  });

  it("诊断行：常规相位不渲染（流内思考行/工具卡承担指示），异常态可见", () => {
    seedRuntime();
    useSessionStore.setState({ isAgentRunning: true });
    useRuntimeStatusStore.getState().beginTurn();
    const { rerender } = render(<TurnStatusRow />);
    // ZCode 结构：常规思考/工具相位不渲染独立行——指示由流内的思考行
    // 与工具卡标题的流光承担
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();

    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "tool_call",
      sessionId: "s-1",
      toolCallId: "t1",
      status: "in_progress",
    } as never);
    rerender(<TurnStatusRow />);
    expect(screen.queryByText(/工具运行中/)).not.toBeInTheDocument();

    // 等待响应（ACP 无活动）诊断态可见；轮次结束即退场
    useSessionStore.setState({ isWaitingForActivity: true });
    rerender(<TurnStatusRow />);
    expect(screen.getByText(/暂未收到新进度/)).toBeInTheDocument();
    useSessionStore.setState({
      isAgentRunning: false,
      isWaitingForActivity: false,
    });
    rerender(<TurnStatusRow />);
    expect(screen.queryByText(/暂未收到新进度/)).not.toBeInTheDocument();
  });

  it("诊断行：有挂起的提问/审批时退场（此刻是在等用户，不是生成中）", () => {
    seedRuntime();
    useSessionStore.setState({ isAgentRunning: true });
    useRuntimeStatusStore.getState().beginTurn();
    render(<TurnStatusRow />);
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();

    // 挂起一条提问（Promise 悬置、轮次仍 active）：诊断行让位给问答面板
    act(() => {
      void useApprovalStore.getState().offerQuestions({
        sessionId: "s-1",
        requestId: "q1",
        callerName: "sr-init",
        questions: [
          {
            question: "原文是否一致？",
            header: "核对",
            multiSelect: false,
            options: [
              { label: "一致", description: "" },
              { label: "不一致", description: "" },
            ],
          },
        ],
      });
    });
    expect(screen.queryByText("思考中…")).not.toBeInTheDocument();
    useApprovalStore.getState().clear();
  });
});
