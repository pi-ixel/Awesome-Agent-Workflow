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
    const groupToggle = screen.getByRole("button", { name: /2 个步骤/ });
    expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getAllByRole("button", { name: /search|read|load skill/ }).length,
    ).toBe(1);

    // 展开工作组：组内工具卡原样渲染
    await userEvent.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getAllByRole("button", { name: /search|read|load skill/ }).length,
    ).toBe(3);

    // 助手 Markdown：代码块语言标签（bash → script.sh，ZCode 式映射）
    expect(screen.getByText("script.sh")).toBeInTheDocument();

    // 思考块折叠入口（按钮名含折叠箭头，按子串匹配）
    expect(
      screen.getByRole("button", { name: /思考过程/ }),
    ).toBeInTheDocument();
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

  it("步骤清单渲染在消息流内（PlanCard），不占停靠坞", () => {
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
    // 流内：清单卡带计数与当前步
    expect(screen.getByText(/任务步骤 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/当前：第二步/)).toBeInTheDocument();
    // 停靠坞里没有计划面板
    const dock = document.querySelector("[data-session-dock]");
    expect(dock?.querySelector('[data-item-kind="plan"]')).toBeNull();
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
