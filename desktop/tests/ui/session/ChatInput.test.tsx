/**
 * 输入区交互：Enter 发送 / Shift+Enter 换行 / IME 组词 / 运行中变「停止」；
 * 悬浮形态（rounded-2xl 卡片、透明输入行、下行元信息条）见「悬浮形态」组。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "../../../src/ui/session/ChatInput.tsx";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useRuntimeStatusStore } from "../../../src/stores/runtimeStatusStore.ts";

function setup(options: { isAgentRunning?: boolean } = {}) {
  const onSend = vi.fn();
  const onEnqueue = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ChatInput
      isAgentRunning={options.isAgentRunning ?? false}
      onSend={onSend}
      onEnqueue={onEnqueue}
      onCancel={onCancel}
    />,
  );
  return { onSend, onEnqueue, onCancel, unmount: view.unmount };
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("消息输入框");
}

// 草稿/输入历史现在按（工作区 × 会话）持久化到 localStorage：
// 不清仓会让前一个用例的草稿被下一个用例恢复，破坏 @ 触发等前置条件
beforeEach(() => {
  window.localStorage.clear();
});

describe("ChatInput", () => {
  it("Enter 发送并清空草稿", async () => {
    const { onSend } = setup();
    await userEvent.type(getTextarea(), "帮我跑下测试{Enter}");
    expect(onSend).toHaveBeenCalledWith("帮我跑下测试");
    expect(getTextarea()).toHaveValue("");
  });

  it("Shift+Enter 换行而不发送", async () => {
    const { onSend } = setup();
    await userEvent.type(getTextarea(), "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(onSend).not.toHaveBeenCalled();
    expect(getTextarea()).toHaveValue("第一行\n第二行");
  });

  it("输入法组词中的 Enter 不发送", () => {
    const { onSend } = setup();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "拼字中" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("拼字中");
  });

  it("空输入（纯空白）禁用发送", async () => {
    const { onSend } = setup();
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toBeDisabled();
    await userEvent.type(getTextarea(), "   ");
    expect(sendButton).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("运行中：无草稿=停止钮；有草稿=发送（入队）钮，Enter 入队不发送", async () => {
    const { onSend, onEnqueue, onCancel } = setup({ isAgentRunning: true });
    // 无草稿：停止钮（发送钮不出现）
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "加入队列" }),
    ).not.toBeInTheDocument();

    // 打字后：切换为「加入队列」发送钮，Enter 入队（不直接发送）
    await userEvent.type(getTextarea(), "排队消息{Enter}");
    expect(onEnqueue).toHaveBeenCalledWith("排队消息");
    expect(onSend).not.toHaveBeenCalled();
    expect(getTextarea()).toHaveValue("");

    // 草稿清空后回到停止钮，点击触发取消
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ChatInput 悬浮形态", () => {
  afterEach(() => {
    // 模型 / 审批模式元信息是本组注入的，收口避免影响其他用例
    useSessionStore.setState({ modelLabel: null, approvalMode: null });
    useRuntimeStatusStore.getState().reset();
  });

  it("模型标识：runtime 模型名优先，回落 sessionStore 的 profile id；短格式与占位 —", () => {
    useSessionStore.setState({
      modelLabel: "0123456789abcdef0123456789abcdef",
    });
    const { rerender } = render(
      <ChatInput isAgentRunning={false} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    // runtime 无模型信息：回落 sessionStore 的 modelLabel（裸 hash 截 12 位）
    expect(screen.getByTitle(/0123456789abcdef/)).toHaveTextContent(
      "0123456789ab",
    );

    // runtimeDetails 带模型名时优先于 profile id
    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "chrys_runtime",
      sessionId: "s-test",
      runtime: {
        modelProfileId: "glm-max",
        runtimeDetails: {
          model: { name: "glm-5.3-flash", provider: "zhipu" },
        },
      },
    });
    rerender(
      <ChatInput isAgentRunning={false} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTitle(/glm-5/)).toHaveTextContent("glm-5.3-flash");

    // 两处都无模型时占位 —
    useSessionStore.setState({ modelLabel: null });
    useRuntimeStatusStore.getState().reset();
    rerender(
      <ChatInput isAgentRunning={false} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("审批模式徽标随 approvalMode 显示", () => {
    useSessionStore.setState({
      approvalMode: { id: "manual", name: "手动审批" },
    });
    render(
      <ChatInput isAgentRunning={false} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTitle("审批模式")).toHaveTextContent("手动审批");
  });

  it("发送为圆形主钮：空输入禁用、填写后可用并发出", async () => {
    const onSend = vi.fn();
    render(
      <ChatInput isAgentRunning={false} onSend={onSend} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toHaveClass("rounded-full");
    expect(sendButton).toBeDisabled();
    await userEvent.type(getTextarea(), "悬浮输入");
    expect(sendButton).toBeEnabled();
    await userEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledWith("悬浮输入");
  });

  it("运行中停止钮为圆形危险钮", () => {
    render(
      <ChatInput isAgentRunning={true} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "停止" })).toHaveClass(
      "rounded-full",
    );
  });

  it("附件占位已移除：功能接入前不留可点却无动作的图标", () => {
    render(
      <ChatInput isAgentRunning={false} onSend={vi.fn()} onEnqueue={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/附件/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/附件/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 输入历史 / @ 提及
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { listWorkspaceFiles } from "../../../src/aaw/fileListing.ts";
import { resetPromptHistoryForTests } from "../../../src/ui/session/promptHistory.ts";

vi.mock("../../../src/aaw/fileListing.ts", () => ({
  listWorkspaceFiles: vi.fn(),
}));

describe("ChatInput 输入历史", () => {
  it("空输入按 ↑ 回溯最近发送，↑↑ 再上一条，↓ 前进并回到空草稿", async () => {
    resetPromptHistoryForTests();
    const { onSend } = setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "第一条{Enter}");
    await userEvent.type(textarea, "第二条{Enter}");
    expect(onSend).toHaveBeenCalledTimes(2);

    await userEvent.type(textarea, "{ArrowUp}");
    expect(textarea).toHaveValue("第二条");
    await userEvent.type(textarea, "{ArrowUp}");
    expect(textarea).toHaveValue("第一条");
    await userEvent.type(textarea, "{ArrowDown}");
    expect(textarea).toHaveValue("第二条");
    await userEvent.type(textarea, "{ArrowDown}");
    // 退出浏览：回到起步时的草稿（空）
    expect(textarea).toHaveValue("");
  });

  it("非空输入且不在浏览态时 ↑ 不劫持（多行编辑自由移动光标）", async () => {
    const { onSend } = setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "多行内容不劫持");
    await userEvent.type(textarea, "{ArrowUp}");
    expect(textarea).toHaveValue("多行内容不劫持");
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ChatInput @ 文件提及", () => {
  it("输入 @ 弹候选面板，Enter 插入 @路径 并关闭面板", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    vi.mocked(listWorkspaceFiles).mockResolvedValue([
      "README.md",
      "src/app.ts",
    ]);
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "看 @rea");
    const option = await screen.findByRole("option", { name: /README/ });
    expect(option).toBeInTheDocument();

    await userEvent.type(textarea, "{Enter}");
    expect(textarea).toHaveValue("看 @README.md ");
    expect(
      screen.queryByRole("listbox", { name: "提及候选" }),
    ).not.toBeInTheDocument();
  });

  it("无匹配显示空态提示，Esc 关闭面板", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    vi.mocked(listWorkspaceFiles).mockResolvedValue(["README.md"]);
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "@zzz");
    expect(
      await screen.findByText("没有匹配的文件或 skill"),
    ).toBeInTheDocument();
    await userEvent.type(textarea, "{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("面板内 ↑↓ 移动选中项（aria-selected 跟随）", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    vi.mocked(listWorkspaceFiles).mockResolvedValue([
      "README.md",
      "src/app.ts",
      "docs/guide.md",
    ]);
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "@");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.type(textarea, "{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.type(textarea, "{ArrowUp}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });
});

// ---------------------------------------------------------------- 草稿持久化（M1）
describe("ChatInput 草稿按（工作区 × 会话）持久化", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    useSessionStore.setState({ activeSessionId: "s-1" });
  });

  it("草稿落盘；重挂载恢复；发送后存稿清空", async () => {
    const first = setup();
    await userEvent.type(getTextarea(), "写到一半的");
    first.unmount();

    const second = setup();
    expect(getTextarea()).toHaveValue("写到一半的");
    await userEvent.type(getTextarea(), "{Enter}");
    expect(second.onSend).toHaveBeenCalledWith("写到一半的");
    expect(getTextarea()).toHaveValue("");
    second.unmount();

    // 发送即清存稿：再挂载不再恢复
    setup();
    expect(getTextarea()).toHaveValue("");
  });

  it("切换会话档位：各会话草稿互不串档", async () => {
    const first = setup();
    await userEvent.type(getTextarea(), "会话一草稿");
    first.unmount();

    useSessionStore.setState({ activeSessionId: "s-2" });
    const second = setup();
    expect(getTextarea()).toHaveValue("");
    second.unmount();

    useSessionStore.setState({ activeSessionId: "s-1" });
    setup();
    expect(getTextarea()).toHaveValue("会话一草稿");
  });
});

// ---------------------------------------------------------------- Slash 命令面板（M6）
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";

describe("ChatInput slash 命令面板", () => {
  beforeEach(() => {
    useSessionStore.getState().clear();
    useWorkbenchUiStore.setState({
      overlay: null,
      isAawOpen: false,
      aawWizardEntry: null,
    });
    useRuntimeStatusStore.getState().reset();
  });

  it("行首 / 弹面板（命令/工作流入口分组）；Enter 执行 /diagnostics 并移除 token", async () => {
    useRuntimeStatusStore.setState({
      runtime: {
        ...useRuntimeStatusStore.getState().runtime,
        skillNames: ["aaw-workflow"],
      },
    });
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "/");
    // 空查询：三个分组齐全
    const panel = await screen.findByRole("listbox", { name: "命令面板" });
    expect(panel.textContent).toContain("命令");
    expect(panel.textContent).toContain("工作流入口");
    expect(panel.textContent).toContain("Skills");
    // 过滤到 diagnostics
    await userEvent.type(textarea, "dia");
    expect(panel).toHaveTextContent("/diagnostics");

    await userEvent.type(textarea, "{Enter}");
    expect(useWorkbenchUiStore.getState().overlay).toBe("diagnostics");
    // action 执行后 /token 从草稿移除
    expect(textarea).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("行中 / 不触发；顿号行首归一触发", async () => {
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "看 /cl");
    expect(screen.queryByRole("listbox", { name: "命令面板" })).not.toBeInTheDocument();
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "、");
    expect(
      await screen.findByRole("listbox", { name: "命令面板" }),
    ).toBeInTheDocument();
  });

  it("/sr 打开 AAW 面板并定位向导入口；Esc 关面板不误执行", async () => {
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "/sr{Enter}");
    const ui = useWorkbenchUiStore.getState();
    expect(ui.isAawOpen).toBe(true);
    expect(ui.aawWizardEntry).toBe("sr");
    expect(textarea).toHaveValue("");

    // Esc 只关面板
    await userEvent.type(textarea, "/ar");
    expect(
      await screen.findByRole("listbox", { name: "命令面板" }),
    ).toBeInTheDocument();
    await userEvent.type(textarea, "{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().aawWizardEntry).toBe("sr");
  });

  it("/clear 清空会话条目", async () => {
    useSessionStore.getState().beginTurn("待清空的消息");
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "/clear{Enter}");
    expect(useSessionStore.getState().items).toHaveLength(0);
  });

  it("skill 项过滤命中并插入提示文本（insert 类）", async () => {
    useRuntimeStatusStore.setState({
      runtime: {
        ...useRuntimeStatusStore.getState().runtime,
        skillNames: ["aaw-workflow"],
      },
    });
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "/aaw");
    const panel = await screen.findByRole("listbox", { name: "命令面板" });
    expect(panel).toHaveTextContent("Skills");
    expect(panel).toHaveTextContent("aaw-workflow");
    // 选中 skill 项：面板首项此时应为 skill（aaw 无静态命令命中）
    await userEvent.type(textarea, "{Enter}");
    expect(textarea.value).toContain("请使用 skill「aaw-workflow」");
  });

  it("@ 多源：skill 名与文件同面板分组出现", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    useRuntimeStatusStore.setState({
      runtime: {
        ...useRuntimeStatusStore.getState().runtime,
        skillNames: ["aaw-workflow"],
      },
    });
    vi.mocked(listWorkspaceFiles).mockResolvedValue(["aaw-config.ts"]);
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "@aaw");
    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((l) => l.includes("aaw-config.ts"))).toBe(true);
    expect(labels.some((l) => l.includes("aaw-workflow"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 审批默认模式切换器（重构后）
import { useSettingsStore } from "../../../src/stores/settingsStore.ts";

describe("ChatInput 审批默认模式切换器", () => {
  beforeEach(() => {
    useSettingsStore.setState({ approvalMode: "ask" });
  });

  it("芯片显示当前策略；菜单两项（无自动拒绝）即时切换", async () => {
    setup();
    expect(
      screen.getByRole("button", { name: "审批默认模式" }),
    ).toHaveTextContent("审批·每次询问");
    await userEvent.click(screen.getByRole("button", { name: "审批默认模式" }));
    const menu = screen.getByRole("menu", { name: "审批默认模式" });
    // ZCode 式富行：标题 + 一句描述
    expect(menu).toHaveTextContent("每次询问");
    expect(menu).toHaveTextContent("改动文件前先向我确认。");
    expect(menu).toHaveTextContent("自动放行");
    expect(menu).toHaveTextContent("默认允许工具调用，减少确认次数。");
    // 「自动拒绝」已下线：菜单不再出现
    expect(menu).not.toHaveTextContent("自动拒绝");

    await userEvent.click(screen.getByRole("menuitem", { name: /自动放行/ }));
    expect(useSettingsStore.getState().approvalMode).toBe("auto-allow");
    expect(
      screen.getByRole("button", { name: "审批默认模式" }),
    ).toHaveTextContent("审批·自动放行");
  });
});
