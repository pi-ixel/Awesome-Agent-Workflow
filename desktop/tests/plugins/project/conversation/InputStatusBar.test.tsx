import { useRuntimeStatusStore, useSessionStore, useApprovalStore } from "../../../helpers/foreground.ts";
/**
 * 输入区状态行（InputStatusBar）测试：上下文用量条（百分比与用量条、
 * 70/90 阈值换色）、skills/mcp 计数徽标与悬停明细、运行状态章（相位文案
 * 随轮次状态机变化，轮次外不显示）。
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InputStatusRight,
  TurnStatusRow,
} from "../../../../src/plugins/project/conversation/ui/InputStatusBar.tsx";

beforeEach(() => {
  useRuntimeStatusStore.getState().reset();
  useSessionStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

function seedRuntime(): void {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_runtime",
    sessionId: "s-1",
    runtime: {
      modelProfileId: "glm-max",
      skillNames: ["aaw-workflow", "code-check"],
      modelName: "GLM-4.6",
      modelProvider: "zhipu",
      mcpServers: [
        { name: "server-a", toolCount: 1 },
        { name: "server-b", toolCount: 2 },
      ],
      mcpFailures: [{ name: "server-c", error: "connection refused" }],
      skillSources: [
        { source: "user", count: 1 },
        { source: "project", count: 1 },
      ],
    },
  });
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s-1",
    usage: {
      sessionId: "s-1",
      pct: 42.5,
      inputTokens: 10000,
      outputTokens: 2500,
      totalTokens: 51000,
      contextUsed: 51000,
      sourceLabel: "ICode 最近调用估算",
      maxContextTokens: 120000,
      totalSessionTokens: 90000,
      cacheHitTokens: 8000,
      totalSessionInputTokens: 60000,
      totalSessionOutputTokens: 30000,
      totalSessionCacheHitTokens: 36000,
      usageSourceId: "s-1",
    },
  } as never);
}

describe("InputStatusBar", () => {
  it("keeps the context ring mounted before usage arrives and after it resets", async () => {
    render(<InputStatusRight />);
    const ring = screen.getByRole("button", { name: /上下文用量/ });
    expect(ring).toBeVisible();
    expect(ring).toHaveTextContent(/^$/);
    await userEvent.hover(ring);
    expect(screen.getByRole("dialog", { name: "上下文容量" })).toHaveTextContent("（未知）");
    expect(screen.getByRole("dialog", { name: "上下文容量" })).not.toHaveTextContent("无法计算占比");
    act(seedRuntime);
    expect(screen.getByRole("button", { name: "上下文用量" })).toBe(ring);
    act(() => useRuntimeStatusStore.getState().reset());
    expect(screen.getByRole("button", { name: /上下文用量/ })).toBe(ring);
  });
  it("已存的上下文容量在新上报前可见，收到新容量后立即更新", async () => {
    useRuntimeStatusStore.getState().setCachedContext({ capacity: 500_000, used: 55_500 });
    render(<InputStatusRight />);
    await userEvent.hover(screen.getByRole("button", { name: "上下文用量" }));
    const card = screen.getByRole("dialog", { name: "上下文容量" });
    const meter = within(card).getByRole("progressbar", { name: "上下文占用" });
    expect(card).toHaveTextContent("55.5k/500k");
    expect(meter).toHaveAttribute("aria-valuetext", "11.1%");
    act(() => useRuntimeStatusStore.getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "s-1",
      contextUsed: 1,
      contextSize: 0,
    }));
    expect(card).toHaveTextContent("55.5k/500k");
    expect(meter).toHaveAttribute("aria-valuetext", "11.1%");
    act(() => useRuntimeStatusStore.getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "s-1",
      contextUsed: 50_000,
      contextSize: 100_000,
    }));
    expect(card).toHaveTextContent("50k/100k");
    expect(meter).toHaveAttribute("aria-valuetext", "50%");
  });
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

  it("上下文容量浮框：悬停出现（头部已用/总量 + 进度条 + 缓存命中率），移开即收", async () => {
    seedRuntime();
    render(<InputStatusRight />);
    const meter = document.querySelector('[data-status="context"]');
    if (meter === null) {
      throw new Error("data-status=context 圆环未渲染");
    }
    // 悬停前无浮框；行内也无百分比（ZCode 同款）
    expect(
      screen.queryByRole("dialog", { name: "上下文容量" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    await userEvent.hover(meter);
    const popover = screen.getByRole("dialog", { name: "上下文容量" });
    expect(popover).toHaveTextContent("51k/120k");
    expect(popover).not.toHaveTextContent("（42.5%）");
    const progress = within(popover).getByRole("progressbar", { name: "上下文占用" });
    expect(progress).toHaveAttribute("aria-valuenow", "42.5");
    expect(progress).toHaveAttribute("aria-valuetext", "42.5%");
    expect(progress).toHaveTextContent("42.5%");
    // 缓存命中率：8000/10000 = 80%
    expect(popover).toHaveTextContent("缓存命中率");
    expect(popover).toHaveTextContent("60%");
    await userEvent.unhover(meter);
    expect(
      screen.queryByRole("dialog", { name: "上下文容量" }),
    ).not.toBeInTheDocument();
    // 占比 42.5% → 进度弧 dashoffset = C×(1−0.425)（ZCode kJt 同式）
    const arc = meter.querySelector("svg circle:last-child");
    if (arc === null) {
      throw new Error("进度弧未渲染");
    }
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      2 * Math.PI * 10 * (1 - 0.425),
      6,
    );
  });

  it("模型切换器无清单时纯展示，有清单时只显示名称并支持切换", async () => {
    seedRuntime();
    const { rerender } = render(<InputStatusRight />);
    // 无清单：纯展示标签（圆环测试另行覆盖，这里只看模型不带 menu）
    expect(
      screen.queryByRole("button", { name: "模型选择" }),
    ).not.toBeInTheDocument();

    const switchModel = vi.fn();
    const refreshModels = vi.fn(() => Promise.resolve());
    useSessionStore.setState({
      availableModels: [
        { modelId: "glm-5", name: "glm-5", description: null },
        {
          modelId: "deepseek-v4",
          name: "deepseek-v4",
          description: "适合长文本推理",
        },
      ],
      currentModelId: "glm-5",
      switchModel,
      ...{ refreshModels },
    });
    rerender(<InputStatusRight />);
    await userEvent.click(screen.getByRole("button", { name: "模型选择" }));
    const menu = screen.getByRole("dialog", { name: "模型选择" });
    const filter = within(menu).getByRole("combobox", { name: "搜索模型" });
    expect(filter).toHaveFocus();
    expect(menu).toHaveTextContent("glm-5");
    expect(menu).toHaveTextContent("deepseek-v4");
    expect(menu).not.toHaveTextContent("适合长文本推理");
    expect(within(menu).getByRole("option", { name: "glm-5", selected: true })).toBeVisible();
    await userEvent.type(filter, "  DEEPSEEK  ");
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    expect(switchModel).not.toHaveBeenCalled();
    expect(refreshModels).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(switchModel).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(switchModel).toHaveBeenCalledWith("deepseek-v4");
    expect(menu).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "模型选择" });
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(screen.getByRole("combobox", { name: "搜索模型" })).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(2);
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

  it("会话运行中可从空列表刷新，并保留打开的菜单", async () => {
    const refreshModels = vi.fn(() => {
      useSessionStore.setState({
        refreshedModels: [{ modelId: "fresh", name: "最新模型" }],
      });
      return Promise.resolve();
    });
    useSessionStore.setState({
      availableModels: [],
      currentModelId: null,
      refreshedModels: null,
      isAgentRunning: true,
      isBound: true,
      ...{ refreshModels },
    });
    try {
      render(<InputStatusRight />);
      await userEvent.click(screen.getByRole("button", { name: "模型选择" }));
      const menu = screen.getByRole("dialog", { name: "模型选择" });
      const search = within(menu).getByRole("combobox", { name: "搜索模型" });
      expect(menu).toHaveTextContent("暂无可用模型");
      await userEvent.type(search, "最新");
      expect(refreshModels).not.toHaveBeenCalled();
      await userEvent.keyboard("{Tab}{Enter}");
      expect(refreshModels).toHaveBeenCalledOnce();
      expect(
        within(menu).getByRole("option", { name: "最新模型" }),
      ).toBeVisible();
      expect(search).toHaveValue("最新");
      expect(menu).toBeVisible();
    } finally {
      useSessionStore.setState({ isBound: false });
    }
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

it("flags 10M/200k as an abnormal report rather than a valid 5000% context", async () => {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "s",
    contextUsed: 10_000_000,
    contextSize: 200_000,
  });
  const { container } = render(<InputStatusRight />);
  const ring = container.querySelector('[data-status="context"]')!;
  await userEvent.hover(ring);
  expect(screen.getByRole("dialog", { name: "上下文容量" })).toHaveTextContent(
    "10M/200k（上报异常）",
  );
  expect(
    screen.getByRole("dialog", { name: "上下文容量" }),
  ).not.toHaveTextContent("5000%");
  expect(screen.queryByRole("progressbar", { name: "上下文占用" })).not.toBeInTheDocument();
});

it.each([0, 11.1, 92.7, 100])("上下文进度保留精确百分比 %s，真实零值不伪造最小填充", async (percent) => {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "s",
    contextUsed: percent * 1000,
    contextSize: 100_000,
  });
  render(<InputStatusRight />);
  await userEvent.hover(screen.getByRole("button", { name: "上下文用量" }));
  const progress = screen.getByRole("progressbar", { name: "上下文占用" });
  expect(progress).toHaveAttribute("aria-valuenow", String(percent));
  expect(progress).toHaveAttribute("aria-valuetext", `${percent}%`);
  expect(progress.firstElementChild).toHaveStyle({ width: `${percent}%` });
});

vi.mock("../../../../src/plugins/project/conversation/ui/useSessionCommands.ts", () => ({
  useSessionCommands: () => useSessionStore((state) => state),
}));

vi.mock("../../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../../helpers/foreground.ts");
  return conversationViewFixture();
});
