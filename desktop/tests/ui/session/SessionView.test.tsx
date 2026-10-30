/**
 * 会话视图组合：回放脚本渲染全类条目、工具条元信息、输入区驱动 store、
 * 运行中「停止」走绑定取消。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "../../../src/ui/session/SessionView.tsx";
import {
  useSessionStore,
  type SessionBinding,
} from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import { replaySampleConversation } from "../../fixtures/sessionScript.ts";

const PATH = "D:/dev/demo-project";

beforeEach(() => {
  useSettingsStore.setState({ messageStreamShowTodos: false });
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({ modelLabel: null, approvalMode: null });
  useWorkspaceStore.setState({ activePath: null });
  useWorkbenchUiStore.setState({ treeView: "session", contextPath: null });
});

describe("SessionView", () => {
  it("回放会话后渲染全部条目类型与输入区元信息（模型 + 审批徽标在输入区下行）", async () => {
    replaySampleConversation();
    render(<SessionView />);

    // 输入区下行：模型 + 审批徽标（原会话工具条元信息，已收编至此）
    expect(screen.getByText("glm-4.7-coding")).toBeInTheDocument();
    expect(screen.getByText("手动审批")).toBeInTheDocument();

    // 用户消息
    expect(
      screen.getByText(
        "帮我看下登录接口为什么返回 401，必要时改掉测试里的过期 token。",
      ),
    ).toBeInTheDocument();

    // 轮内已完成工作折叠：两张连续完成的工具卡（search + read）收进
    // 一个默认收起的工作组，单张的 load skill 仍在流中
    expect(screen.queryByText("load skill")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已处理" }));
    const groupToggle = screen.getByRole("button", { name: /2 个步骤/ });
    expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    // read/search 已改摘要行（div，不可展开）；仍在流中的 load skill
    // 保持开关行，主文本 = 结果摘要（标题只作 hover 提示）
    expect(
      screen.getAllByRole("button", { name: /技能 test-writer 已加载/ }).length,
    ).toBe(1);

    // 展开工作组：search 主文本为「查找 {query}」句式、read 为文件 chip
    // + 次级目录路径（对齐 ZCode renderers）
    await userEvent.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("查找 login")).toBeInTheDocument();
    // 文件名与助手正文里的行内代码重名：getAllByText 兜住 chip + code 两处
    expect(screen.getAllByText("login.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("src/api/")).toBeInTheDocument();
    // ⓘ 展开按钮已删：read/search 行内不再有「查看详情」
    expect(
      screen.queryByRole("button", { name: "查看详情" }),
    ).not.toBeInTheDocument();

    // 助手 Markdown：代码块语言标签（bash → script.sh，ZCode 式映射）
    expect(screen.getByText("script.sh")).toBeInTheDocument();

    // 思考块折叠入口（按钮名 =「思考 · 持续了 N 秒」三段标签，按子串匹配）
    expect(screen.getByRole("button", { name: /思考/ })).toBeInTheDocument();
  });

  it("空会话显示引导文案", () => {
    render(<SessionView />);
    // hero 空态：时段问候 + 主旨问句 + 入口 chips
    expect(screen.getByText(/，今天想推进什么？/)).toBeInTheDocument();
  });

  it("项目已关闭（无 activePath）时空态改为「项目已关闭」并提供重新打开入口", async () => {
    useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
    render(<SessionView />);

    expect(screen.getByText("项目已关闭")).toBeInTheDocument();
    expect(
      screen.queryByText("会话为空。发送第一条消息即可开始。"),
    ).not.toBeInTheDocument();

    // 重新打开项目：把路径写回 activePath（RealSessionRuntime 据此重连）
    await userEvent.click(screen.getByRole("button", { name: "重新打开项目" }));
    expect(useWorkspaceStore.getState().activePath).toBe(PATH);
  });

  it("输入 + Enter 经 store 发送：落用户消息并调用绑定 prompt", async () => {
    const prompt = vi.fn(
      () => new Promise<{ stopReason: "end_turn" }>(() => undefined),
    );
    const binding: SessionBinding = { prompt, cancel: vi.fn() };
    useSessionStore.getState().bindSession(binding);
    render(<SessionView />);

    await userEvent.type(screen.getByLabelText("消息输入框"), "第一问{Enter}");
    expect(prompt).toHaveBeenCalledWith("第一问");
    expect(await screen.findByText("第一问")).toBeInTheDocument();
    // 运行中：输入区变停止按钮
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("运行中点击「停止」触发绑定的 cancel（session/cancel）", async () => {
    const cancel = vi.fn();
    const binding: SessionBinding = {
      prompt: () => new Promise<{ stopReason: "cancelled" }>(() => undefined),
      cancel,
    };
    useSessionStore.getState().bindSession(binding);
    render(<SessionView />);
    await userEvent.type(
      screen.getByLabelText("消息输入框"),
      "跑长任务{Enter}",
    );
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("未绑定时发送：提示未连接且不落用户消息", async () => {
    render(<SessionView />);
    await userEvent.type(
      screen.getByLabelText("消息输入框"),
      "没有 agent{Enter}",
    );
    expect(await screen.findByText(/尚未连接 agent/)).toBeInTheDocument();
    expect(screen.queryByText("没有 agent")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 窗口化与空态入口
import type { SessionItem } from "../../../src/stores/sessionStore.ts";

describe("SessionView 长会话窗口化与空态入口", () => {
  it("300 条长会话只渲染最近 150 条；滚动到顶补载更早一块", async () => {
    const items: SessionItem[] = Array.from({ length: 300 }, (_, index) => ({
      kind: "user" as const,
      id: `u${index}`,
      text: `消息${index}`,
      createdAt: "2026-10-24T10:00:00Z",
    }));
    useSessionStore.setState({ items });
    render(<SessionView />);

    // 旧块未挂载，最近块在
    expect(screen.queryByText("消息0")).not.toBeInTheDocument();
    expect(screen.getByText("消息299")).toBeInTheDocument();

    // 贴顶滚动触发补载（jsdom 中 scrollTop=0 恒贴顶）
    fireEvent.scroll(screen.getByRole("log", { name: "消息流" }));
    expect(await screen.findByText("消息0")).toBeInTheDocument();
    expect(screen.getByText("消息299")).toBeInTheDocument();
  });

  it("发送消息：渐进回补完成后重钉贴底（回归——视口跳到中间、新消息不可见）", () => {
    const items: SessionItem[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "user" as const,
      id: `u${index}`,
      text: `消息${index}`,
      createdAt: "2026-10-24T10:00:00Z",
    }));
    useSessionStore.setState({ items });
    // 追赶循环用 rAF 分帧挂载：同步驱动让窗口内回合即刻全量就绪
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { container } = render(<SessionView />);
      const scroll =
        container.querySelector<HTMLElement>('[aria-label="消息流"]');
      if (scroll === null) throw new Error("消息流容器未找到");
      // jsdom 无布局：以回合数合成高度，发送前后 DOM 高度可区分——真实
      // 浏览器里这个差值就是被退场-回补的那个最旧回合的高度
      const heightOf = (): number =>
        scroll.querySelectorAll("li").length * 1000;
      Object.defineProperty(scroll, "scrollHeight", {
        configurable: true,
        get: heightOf,
      });
      Object.defineProperty(scroll, "clientHeight", {
        configurable: true,
        get: () => 1000,
      });
      Object.defineProperty(scroll, "scrollTop", {
        configurable: true,
        value: 0,
        writable: true,
      });
      const turnsBefore = scroll.querySelectorAll("li").length;

      act(() => {
        useSessionStore.getState().beginTurn("这条消息必须在底部可见");
      });

      // 新回合进窗口（退场-回补：最旧回合下一帧回补）
      expect(screen.getByText("这条消息必须在底部可见")).toBeInTheDocument();
      expect(scroll.querySelectorAll("li").length).toBe(turnsBefore + 1);
      // 回补完成后重钉贴底：scrollTop 与最终内容高度一致
      expect(scroll.scrollTop).toBe(heightOf());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("追赶挂载期间上滚：阅读位置随前插锚平移，不被拖向会话中部", () => {
    const items: SessionItem[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "user" as const,
      id: `u${index}`,
      text: `消息${index}`,
      createdAt: "2026-10-24T10:00:00Z",
    }));
    useSessionStore.setState({ items });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { container } = render(<SessionView />);
      const scroll =
        container.querySelector<HTMLElement>('[aria-label="消息流"]');
      if (scroll === null) throw new Error("消息流容器未找到");
      const heightOf = (): number =>
        scroll.querySelectorAll("li").length * 1000;
      Object.defineProperty(scroll, "scrollHeight", {
        configurable: true,
        get: heightOf,
      });
      Object.defineProperty(scroll, "clientHeight", {
        configurable: true,
        get: () => 1000,
      });
      Object.defineProperty(scroll, "scrollTop", {
        configurable: true,
        value: 0,
        writable: true,
      });
      // 用户上滚：wheel 意图先行（scroll 事件竞态前拿走滚动权），落在离底
      // 2000px 的阅读位
      scroll.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          bubbles: true,
          cancelable: true,
        }),
      );
      const readingTop = heightOf() - 1000 - 2000;
      scroll.scrollTop = readingTop;
      fireEvent.scroll(scroll);
      expect(
        screen.getByRole("button", { name: "回到底部" }),
      ).toBeInTheDocument();

      // 追加一轮触发渐进回补：内容在顶部撑高，阅读位必须原地保持
      const anchor = heightOf() - readingTop;
      act(() => {
        useSessionStore.getState().beginTurn("这条消息不得拖走阅读位置");
      });
      expect(scroll.scrollTop).toBe(heightOf() - anchor);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("空会话给推荐入口 chips；点击预填输入框（不自动发送）", async () => {
    render(<SessionView />);
    await userEvent.click(
      screen.getByRole("button", { name: "启动一条工作流" }),
    );
    expect(screen.getByLabelText("消息输入框")).toHaveValue(
      "请从 sr 入口新建一条 AAW 工作流，先与我确认需求。",
    );
    // 预填不是发送：消息流仍呈空态 hero
    expect(screen.getByText(/，今天想推进什么？/)).toBeInTheDocument();
  });

  it("空态居中布局：chips 位于输入框下方；首条消息落地即退场", () => {
    render(<SessionView />);
    const input = screen.getByLabelText("消息输入框");
    const chip = screen.getByRole("button", { name: "启动一条工作流" });
    // 呈现顺序约束（ZCode 式空态的一组居中）：问候 → 输入框 → chips
    expect(
      input.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 首条消息落地：空态（问候与 chips）整体退场，回落贴底布局
    act(() => {
      useSessionStore.setState({
        items: [
          {
            kind: "user",
            id: "u1",
            text: "第一问",
            createdAt: "2026-10-29T10:00:00Z",
          },
        ],
      });
    });
    expect(
      screen.queryByRole("button", { name: "启动一条工作流" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/，今天想推进什么？/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- Esc 全局停止（M1）
import { useApprovalStore } from "../../../src/stores/approvalStore.ts";
import type { PendingPermission } from "../../../src/stores/approvalStore.ts";

describe("SessionView Esc 全局停止", () => {
  const pendingPermission: PendingPermission = {
    kind: "permission",
    id: "permission:t-esc",
    sessionId: "s1",
    toolCallId: "t-esc",
    toolName: "edit_file",
    toolKind: "edit",
    title: "edit_file a.ts",
    reason: null,
    inputSummary: "path=a.ts",
    rawInput: {},
    options: [],
    inboxTitle: "权限审批",
    createdAt: "2026-10-26T10:00:00Z",
  };

  beforeEach(() => {
    useApprovalStore.setState({ pending: [], activeId: null });
    useWorkbenchUiStore.setState({ overlay: null, isTimelineCollapsed: true });
  });

  async function startRunningTurn(cancel: () => void): Promise<void> {
    useSessionStore.getState().bindSession({
      prompt: () => new Promise<{ stopReason: "end_turn" }>(() => undefined),
      cancel,
    });
    render(<SessionView />);
    await userEvent.type(screen.getByLabelText("消息输入框"), "长任务{Enter}");
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  }

  it("运行中按 Esc 触发 cancel（session/cancel）", async () => {
    const cancel = vi.fn();
    await startRunningTurn(cancel);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("空闲时按 Esc 不触发 cancel", async () => {
    const cancel = vi.fn();
    await startRunningTurn(cancel);
    // 先结束轮次（进入空闲）
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("挂起审批时 Esc 让位（不误停 agent）", async () => {
    const cancel = vi.fn();
    await startRunningTurn(cancel);
    useApprovalStore.setState({ pending: [pendingPermission] });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("时间线抽屉展开时 Esc 让位给抽屉收起", async () => {
    const cancel = vi.fn();
    await startRunningTurn(cancel);
    useWorkbenchUiStore.setState({ isTimelineCollapsed: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("覆盖页（设置 / 诊断）打开时 Esc 不停止", async () => {
    const cancel = vi.fn();
    await startRunningTurn(cancel);
    useWorkbenchUiStore.setState({ overlay: "settings" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 消息队列停靠（M4）
describe("SessionView 消息队列 / 停靠坞 / 流内步骤清单", () => {
  it("运行中输入 Enter 入队：QueueDock 出现在停靠坞（输入区上方）", async () => {
    const prompt = vi.fn(
      () => new Promise<{ stopReason: "end_turn" }>(() => undefined),
    );
    useSessionStore.getState().bindSession({ prompt, cancel: vi.fn() });
    render(<SessionView />);
    await userEvent.type(screen.getByLabelText("消息输入框"), "任务一{Enter}");
    await userEvent.type(screen.getByLabelText("消息输入框"), "任务二{Enter}");
    // 第一轮真实发送，第二轮排队
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText("队列 · 1 条待发")).toBeInTheDocument();
    expect(screen.getByText("任务二")).toBeInTheDocument();
  });

  it("停靠坞顺序：问答 > 队列（队列紧挨输入框，无其他面板插队）", () => {
    useSessionStore.setState({
      isAgentRunning: true,
      queuedPrompts: ["排队消息"],
    });
    useApprovalStore.setState({
      pending: [
        {
          kind: "questions",
          id: "questions:r1",
          sessionId: "s1",
          requestId: "r1",
          questions: [
            {
              question: "选哪个？",
              header: "选择",
              options: [
                { label: "甲", description: "" },
                { label: "乙", description: "" },
              ],
              multiSelect: false,
            },
          ],
          callerName: null,
          inboxTitle: "结构化提问",
          createdAt: "2026-10-27T10:00:00Z",
        },
      ],
      activeId: "questions:r1",
    });
    render(<SessionView />);
    const dock = document.querySelector("[data-session-dock]");
    expect(dock).not.toBeNull();
    const sections = Array.from(
      dock?.querySelectorAll(
        '[aria-label="结构化问答"], [aria-label="排队消息"]',
      ) ?? [],
    ).map((el) => el.getAttribute("aria-label"));
    expect(sections).toEqual(["结构化问答", "排队消息"]);
  });

  it("步骤清单默认隐藏，设置开启后渲染在消息流内且不占停靠坞", () => {
    useSessionStore.setState({
      isAgentRunning: true,
      queuedPrompts: ["排队消息"],
      items: [
        {
          kind: "user",
          id: "u-plan",
          text: "带清单的任务",
          createdAt: "2026-10-27T10:00:00Z",
        },
        {
          kind: "plan",
          id: "plan-1",
          entries: [
            { content: "第一步", priority: "medium", status: "completed" },
            { content: "第二步", priority: "medium", status: "in_progress" },
          ],
        },
      ],
    });
    render(<SessionView />);
    expect(screen.queryByText(/任务步骤 1\/2/)).not.toBeInTheDocument();
    act(() => useSettingsStore.getState().setMessageStreamShowTodos(true));
    // 流内：清单卡带计数与当前步
    expect(screen.getByText(/任务步骤 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/当前：第二步/)).toBeInTheDocument();
    // 停靠坞里没有计划面板
    const dock = document.querySelector("[data-session-dock]");
    expect(dock?.querySelector('[data-item-kind="plan"]')).toBeNull();
    act(() => useSettingsStore.getState().setMessageStreamShowTodos(false));
    expect(screen.queryByText(/任务步骤 1\/2/)).not.toBeInTheDocument();
    expect(
      useSessionStore.getState().items.some((item) => item.kind === "plan"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- 内容宽度三档（就地切换）
import { useSettingsStore } from "../../../src/stores/settingsStore.ts";

describe("SessionView 内容宽度", () => {
  it("右上角按钮三档循环：ol / 停靠坞 / 输入卡同档变宽并持久化", async () => {
    useSettingsStore.setState({ chatWidth: "standard" });
    useSessionStore.setState({
      items: [
        {
          kind: "user",
          id: "u-width",
          text: "有内容的会话",
          createdAt: "2026-10-27T10:00:00Z",
        },
      ],
    });
    render(<SessionView />);
    // 图标按钮：无文字，档位经 aria-label 传达
    const toggle = screen.getByRole("button", { name: "内容宽度：标准" });
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(
      document.querySelector('[aria-label="消息流"] ol')?.className,
    ).toContain("max-w-4xl");

    // 标准 → 宽
    await userEvent.click(toggle);
    expect(useSettingsStore.getState().chatWidth).toBe("wide");
    expect(
      screen.getByRole("button", { name: "内容宽度：宽" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[aria-label="消息流"] ol')?.className,
    ).toContain("max-w-6xl");
    expect(document.querySelector(".composer-card")?.className).toContain(
      "max-w-6xl",
    );

    // 宽 → 全宽
    await userEvent.click(screen.getByRole("button", { name: "内容宽度：宽" }));
    expect(useSettingsStore.getState().chatWidth).toBe("full");
    expect(
      document.querySelector('[aria-label="消息流"] ol')?.className,
    ).toContain("max-w-none");

    // 全宽 → 标准（循环）
    await userEvent.click(
      screen.getByRole("button", { name: "内容宽度：全宽" }),
    );
    expect(useSettingsStore.getState().chatWidth).toBe("standard");
  });
});

it("大量缓存和持续回放都不会在加载动效前露出信息流", () => {
  vi.useFakeTimers();
  const items: SessionItem[] = Array.from({ length: 300 }, (_, i) => ({
    kind: "user",
    id: `cached-${i}`,
    text: `缓存消息${i}`,
    createdAt: "2026-10-30T00:00:00Z",
  }));
  useSessionStore.setState({ items, openingSessionId: "target" });
  const view = render(<SessionView />);
  try {
    expect(
      screen.getByRole("heading", { name: "Awesome Agent Workspace" }),
    ).toBeVisible();
    expect(screen.queryByText("缓存消息299")).not.toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        isConnecting: true,
        openingSessionId: null,
        items: [],
      }),
    );
    act(() => useSessionStore.setState({ items }));
    expect(screen.queryByText("缓存消息299")).not.toBeInTheDocument();
    act(() => useSessionStore.setState({ isConnecting: false }));
    expect(screen.queryByText("缓存消息299")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("缓存消息299")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Awesome Agent Workspace" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it.each(["连接后清空消息", "准备打开会话"])(
  "%s 时展示动效而非项目空态",
  (stage) => {
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({
      isConnecting: stage === "连接后清空消息",
      openingSessionId: stage === "准备打开会话" ? "target" : null,
      items:
        stage === "连接后清空消息"
          ? [
              {
                kind: "user",
                id: "cached",
                text: "旧消息",
                createdAt: "2026-10-30T00:00:00Z",
              },
            ]
          : [],
      sessionsByPath: {
        [PATH]: [
          {
            id: "target",
            title: "目标会话",
            updatedAt: "2026-10-30T00:00:00Z",
          },
        ],
      },
    });
    render(<SessionView />);
    act(() => useSessionStore.setState({ items: [] }));
    expect(
      screen.getByRole("heading", { name: "Awesome Agent Workspace" }),
    ).toBeVisible();
    expect(screen.queryByText("继续该项目的工作")).not.toBeInTheDocument();
  },
);

it("已打开的空会话不显示项目会话选择列表", () => {
  useWorkspaceStore.setState({ activePath: PATH });
  useSessionStore.setState({
    activeSessionId: "target",
    sessionsByPath: {
      [PATH]: [
        { id: "target", title: "目标会话", updatedAt: "2026-10-30T00:00:00Z" },
      ],
    },
  });
  render(<SessionView />);
  expect(screen.queryByText("继续该项目的工作")).not.toBeInTheDocument();
  expect(screen.getByLabelText("消息输入框")).toBeVisible();
});

it("连接中的输入框隐藏但保持挂载，动效结束后恢复", () => {
  vi.useFakeTimers();
  useSessionStore.setState({ isConnecting: true, items: [] });
  const view = render(<SessionView />);
  try {
    expect(
      screen.getByRole("heading", { name: "Awesome Agent Workspace" }),
    ).toBeInTheDocument();
    const composer =
      view.container.querySelector("[contenteditable]") ??
      view.container.querySelector("textarea");
    expect(composer).not.toBeNull();
    expect(composer).not.toBeVisible();
    act(() => useSessionStore.setState({ isConnecting: false }));
    expect(composer).not.toBeVisible();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(
      screen.queryByRole("heading", { name: "Awesome Agent Workspace" }),
    ).not.toBeInTheDocument();
    expect(composer).toBeVisible();
    expect(composer?.isConnected).toBe(true);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
