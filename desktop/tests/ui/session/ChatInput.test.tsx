import { registerTestWorkflow } from "../../helpers/workflowWorkbench.ts";
import { useWorkbenchUiStore } from "../../helpers/layout.ts";
import { testComposer } from "../../helpers/composer.ts";
import { useRegisteredSnapshot } from "../../../src/shared/state/useRegisteredSnapshot.ts";
import { useSessionStore, useRuntimeStatusStore } from "../../helpers/foreground.ts";
/**
 * 输入区交互：Enter 发送 / Shift+Enter 换行 / IME 组词 / 运行中变「停止」；
 * 悬浮形态（rounded-2xl 卡片、透明输入行、下行元信息条）见「悬浮形态」组。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { createStore } from "zustand";
import type { ReadonlySnapshot } from "../../../src/shared/state/readonlySnapshot.ts";
import type { FileCandidates } from "../../../src/plugins/project/conversation/ui/documentView.ts";
import { createTestSkills, skillsWorkbenchFixture } from "../../helpers/skills.tsx";
import { createTestProjectPreferences, projectPreferencesWrapper } from "../../helpers/projectPreferences.tsx";

const openDiagnostics = vi.fn();

import { ChatInput } from "../../../src/plugins/project/conversation/ui/ChatInput.tsx";
import { createAnnotationDraftStore } from "../../../src/plugins/project/composer/annotationDraftStore.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import {
  draftScopeKey,
  legacyNewDraftScopeKey,
  readDraft,
  writeDraft,
} from "../../../src/plugins/project/composer/draftStore.ts";

const projectPreferences = createTestProjectPreferences();
const PreferencesWrapper = projectPreferencesWrapper(projectPreferences);

function setup(options: {
  isAgentRunning?: boolean;
  skills?: ReturnType<typeof skillsWorkbenchFixture>;
  workflow?: ReturnType<typeof registerTestWorkflow>;
  openDiagnostics?: () => void;
  documentsWorkbench?: ReturnType<typeof createTestProjectWorkbench>;
  fileCandidates?: ReadonlySnapshot<FileCandidates | undefined>;
} = {}) {
  const onSend = vi.fn();
  const onEnqueue = vi.fn();
  const onCancel = vi.fn();
  const Workbench = options.skills?.Wrapper ?? options.documentsWorkbench?.Wrapper;
  function Wrapper({ children }: PropsWithChildren) {
    return <PreferencesWrapper>{Workbench ? <Workbench>{children}</Workbench> : children}</PreferencesWrapper>;
  }
  function TestInput() {
    const skillCandidates = useRegisteredSnapshot(options.skills?.candidates, (state) => state);
    const fileCandidates = useRegisteredSnapshot(options.fileCandidates, (state) => state);
    return (
      <ChatInput
        fileCandidates={fileCandidates}
        skillCandidates={skillCandidates}
        workflowEntries={options.workflow?.view.entries}
        openDiagnostics={options.openDiagnostics}
        isAgentRunning={options.isAgentRunning ?? false}
        onSend={onSend}
        onEnqueue={onEnqueue}
        onCancel={onCancel}
      />
    );
  }
  const view = render(<TestInput />, { wrapper: Wrapper });
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
      <ChatInput
        isAgentRunning={false}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // runtime 无模型信息：回落 sessionStore 的 modelLabel（裸 hash 截 12 位）
    expect(screen.getByTitle(/0123456789abcdef/)).toHaveTextContent(
      "0123456789ab",
    );

    // runtimeDetails 带模型名时优先于 profile id
    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "agent_runtime",
      sessionId: "s-test",
      runtime: {
        modelProfileId: "glm-max",
        modelName: "glm-5.3-flash",
        modelProvider: "zhipu",
      },
    });
    rerender(
      <ChatInput
        isAgentRunning={false}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTitle(/glm-5/)).toHaveTextContent("glm-5.3-flash");

    // 两处都无模型时占位 —
    useSessionStore.setState({ modelLabel: null });
    useRuntimeStatusStore.getState().reset();
    rerender(
      <ChatInput
        isAgentRunning={false}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("仅显示 AAW 审批策略，不展示 Agent 模式徽标", () => {
    useSessionStore.setState({
      approvalMode: { id: "manual", name: "手动审批" },
    });
    render(
      <ChatInput
        isAgentRunning={false}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTitle("审批模式")).toBeNull();
    expect(screen.queryByText("手动审批")).toBeNull();
    expect(
      screen.getByRole("button", { name: "审批默认模式" }),
    ).toBeInTheDocument();
  });

  it("发送为圆角主钮：空输入禁用、填写后可用并发出", async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        isAgentRunning={false}
        onSend={onSend}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toHaveClass(
      "rounded-lg",
      "h-7",
      "bg-brand",
      "text-foreground-inverse",
    );
    expect(sendButton).toBeDisabled();
    await userEvent.type(getTextarea(), "悬浮输入");
    expect(sendButton).toBeEnabled();
    await userEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledWith("悬浮输入");
  });

  it("运行中停止钮为 ZCode 式次级钮", () => {
    render(
      <ChatInput
        isAgentRunning={true}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "停止" })).toHaveClass(
      "rounded-lg",
      "bg-raised",
    );
  });

  it("附件占位已移除：功能接入前不留可点却无动作的图标", () => {
    render(
      <ChatInput
        isAgentRunning={false}
        onSend={vi.fn()}
        onEnqueue={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/附件/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/附件/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 输入历史 / @ 提及
import { createTestWorkspace } from "../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();
import type { DocumentFileHost } from "../../../src/plugins/host/types.ts";
import { documentFileHost } from "../../helpers/documents.ts";
import { createTestDocuments } from "../../helpers/documents.ts";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";

const listWorkspaceFiles = vi.fn<DocumentFileHost["listWorkspaceFiles"]>();

describe("ChatInput 输入历史", () => {
  it("空输入按 ↑ 回溯最近发送，↑↑ 再上一条，↓ 前进并回到空草稿", async () => {
    testComposer.history.setScope("reset-test");
  testComposer.history.setScope(null);
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
  const fileCandidates = createStore<FileCandidates | undefined>(() => undefined);
  let documents: ReturnType<typeof createTestDocuments>;
  beforeEach(() => {
    documents = createTestDocuments({ ...documentFileHost, listWorkspaceFiles });
    fileCandidates.setState(documents, true);
  });
  afterEach(() => {
    fileCandidates.setState(undefined, true);
    documents.dispose();
  });
  it("输入 @ 弹候选面板，Enter 插入 @路径 并关闭面板", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    vi.mocked(listWorkspaceFiles).mockResolvedValue([
      "README.md",
      "src/app.ts",
    ]);
    setup({ fileCandidates });
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

  it("文档服务重装时重新获取候选并忽略旧实例的迟到结果", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    let finish!: (paths: readonly string[]) => void;
    listWorkspaceFiles.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    setup({ fileCandidates });
    await userEvent.type(getTextarea(), "@");
    await screen.findByText("正在读取文件列表…");
    const replacement = createTestDocuments({
      ...documentFileHost,
      listWorkspaceFiles: () => Promise.resolve(["new-instance.md"]),
    });
    try {
      act(() => {
        documents.dispose();
        fileCandidates.setState(replacement, true);
      });
      expect(await screen.findByRole("option", { name: /new-instance\.md/ })).toBeInTheDocument();
      await act(() => { finish(["retired-instance.md"]); return Promise.resolve(); });
      expect(screen.queryByRole("option", { name: /retired-instance\.md/ })).toBeNull();
    } finally {
      act(() => fileCandidates.setState(undefined, true));
      replacement.dispose();
      finish([]);
    }
  });

  it("无匹配显示空态提示，Esc 关闭面板", async () => {
    useWorkspaceStore.setState({ activePath: "D:/dev/demo" });
    vi.mocked(listWorkspaceFiles).mockResolvedValue(["README.md"]);
    setup({ fileCandidates });
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
    setup({ fileCandidates });
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
  it("未发送的新会话按项目保留文字，切到历史会话或其他项目不串档", async () => {
    useSessionStore.setState({ activeSessionId: null });
    const view = setup();
    await userEvent.type(getTextarea(), "项目A未发送");
    act(() => useSessionStore.setState({ activeSessionId: "history" }));
    expect(getTextarea()).toHaveValue("");
    await userEvent.type(getTextarea(), "历史会话文字");
    act(() => {
      useWorkspaceStore.setState({ activePath: "D:/dev/other" });
      useSessionStore.setState({ activeSessionId: null });
    });
    expect(getTextarea()).toHaveValue("");
    await userEvent.type(getTextarea(), "项目B未发送");
    act(() => useWorkspaceStore.setState({ activePath: "D:/dev/demo" }));
    expect(getTextarea()).toHaveValue("项目A未发送");
    await userEvent.type(getTextarea(), "{Enter}");
    expect(view.onSend).toHaveBeenCalledWith("项目A未发送");
    act(() => useWorkspaceStore.setState({ activePath: "D:/dev/other" }));
    expect(getTextarea()).toHaveValue("项目B未发送");
    act(() => useWorkspaceStore.setState({ activePath: "D:/dev/demo" }));
    expect(getTextarea()).toHaveValue("");
  });

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

describe("ChatInput slash 命令面板", () => {
  let skills: ReturnType<typeof createTestSkills>;
  let skillWorkbench: ReturnType<typeof skillsWorkbenchFixture>;
  let workflow: ReturnType<typeof registerTestWorkflow>;
  let documents: ReturnType<typeof createTestDocuments>;
  beforeEach(() => {
    skills = createTestSkills();
    skillWorkbench = skillsWorkbenchFixture(skills);
    skillWorkbench.workbench.navigation.getState().openView("session", "D:/slash");
    workflow = registerTestWorkflow(skillWorkbench.workbench);
    documents = createTestDocuments({ ...documentFileHost, listWorkspaceFiles });
    useSessionStore.getState().clear();
    useWorkbenchUiStore.setState({
      overlay: null,


    });
    useRuntimeStatusStore.getState().reset();
  });
  afterEach(async () => {
    workflow.dispose();
    documents.dispose();
    skillWorkbench.dispose();
    await skills.dispose();
  });

  it("行首 / 弹面板（命令/工作流入口分组）；Enter 执行 /diagnostics 并移除 token", async () => {
    useRuntimeStatusStore.setState({
      runtime: {
        ...useRuntimeStatusStore.getState().runtime,
        skillNames: ["aaw-workflow"],
        skillInvocations: {
          "aaw-workflow": "请使用 skill「aaw-workflow」来处理这次任务",
        },
      },
    });
    setup({ skills: skillWorkbench, workflow, openDiagnostics });
    const textarea = getTextarea();
    await userEvent.type(textarea, "/");
    // 空查询：三个分组齐全
    const panel = await screen.findByRole("listbox", { name: "命令面板" });
    expect(panel.textContent).toContain("命令");
    expect(panel.textContent).toContain("工作流入口");
    expect(panel.textContent).toContain("Skills");
    act(skillWorkbench.release);
    expect(panel).not.toHaveTextContent("aaw-workflow");
    expect(panel).toHaveTextContent("命令");
    // 过滤到 diagnostics
    await userEvent.type(textarea, "dia");
    expect(panel).toHaveTextContent("/diagnostics");

    await userEvent.type(textarea, "{Enter}");
    // 诊断单独打开，不阻挡主窗口操作。
    expect(openDiagnostics).toHaveBeenCalled();
    expect(useWorkbenchUiStore.getState().overlay).not.toBe("settings");
    // action 执行后 /token 从草稿移除
    expect(textarea).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("行中 / 不触发；顿号行首归一触发", async () => {
    setup();
    const textarea = getTextarea();
    await userEvent.type(textarea, "看 /cl");
    expect(
      screen.queryByRole("listbox", { name: "命令面板" }),
    ).not.toBeInTheDocument();
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "、");
    expect(
      await screen.findByRole("listbox", { name: "命令面板" }),
    ).toBeInTheDocument();
  });

  it("/sr 打开 AAW 面板并定位向导入口；Esc 关面板不误执行", async () => {
    setup({ skills: skillWorkbench, workflow, openDiagnostics });
    const textarea = getTextarea();
    await userEvent.type(textarea, "/sr{Enter}");
    const readPanel = () => skillWorkbench.workbench.panels.getState().projects["d:/slash"];
    expect(readPanel()).toMatchObject({ active: "aaw", toolViews: { aaw: "launch" }, open: true });
    expect(textarea).toHaveValue("");

    const panel = readPanel();
    // Esc 只关命令面板
    await userEvent.type(textarea, "/ar");
    expect(
      await screen.findByRole("listbox", { name: "命令面板" }),
    ).toBeInTheDocument();
    await userEvent.type(textarea, "{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(readPanel()).toBe(panel);
  });

  it("/clear 清空会话条目", async () => {
    useSessionStore.getState().beginTurn("待清空的消息");
    const fixture = createTestProjectWorkbench({
      conversation: { clear: () => useSessionStore.getState().clear() },
    });
    try {
      setup({ documentsWorkbench: fixture });
      await userEvent.type(getTextarea(), "/clear{Enter}");
      expect(useSessionStore.getState().items).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("skill 项过滤命中并插入提示文本（insert 类）", async () => {
    useRuntimeStatusStore.setState({
      runtime: {
        ...useRuntimeStatusStore.getState().runtime,
        skillNames: ["aaw-workflow"],
        skillInvocations: {
          "aaw-workflow": "请使用 skill「aaw-workflow」来处理这次任务",
        },
      },
    });
    setup({ skills: skillWorkbench, workflow, openDiagnostics });
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
        skillInvocations: {
          "aaw-workflow": "请使用 skill「aaw-workflow」来处理这次任务",
        },
      },
    });
    vi.mocked(listWorkspaceFiles).mockResolvedValue(["aaw-config.ts"]);
    const fileCandidates = createStore<FileCandidates | undefined>(() => documents);
    setup({ skills: skillWorkbench, workflow, fileCandidates });
    const textarea = getTextarea();
    await userEvent.type(textarea, "@aaw");
    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((l) => l.includes("aaw-config.ts"))).toBe(true);
    expect(labels.some((l) => l.includes("aaw-workflow"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 审批默认模式切换器（重构后）
describe("ChatInput 审批默认模式切换器", () => {
  beforeEach(() => {
    projectPreferences.setApprovalMode("ask");
  });

  it("芯片显示当前策略；菜单两项（无自动拒绝）即时切换", async () => {
    setup();
    expect(
      screen.getByRole("button", { name: "审批默认模式" }),
    ).toHaveTextContent("每次询问");
    await userEvent.click(screen.getByRole("button", { name: "审批默认模式" }));
    const menu = screen.getByRole("menu", { name: "审批默认模式" });
    // ZCode 式富行：标题 + 一句描述
    expect(menu).toHaveTextContent("每次询问");
    expect(menu).toHaveTextContent("收到权限请求时，由你确认。");
    expect(menu).toHaveTextContent("自动放行");
    expect(menu).toHaveTextContent("自动批准可放行的请求，其余仍询问。");
    // 「自动拒绝」已下线：菜单不再出现
    expect(menu).not.toHaveTextContent("自动拒绝");

    await userEvent.click(screen.getByRole("menuitem", { name: /自动放行/ }));
    expect(projectPreferences.getState().approvalMode).toBe("auto-allow");
    expect(
      screen.queryByRole("menu", { name: "审批默认模式" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "审批默认模式" }),
    ).toHaveTextContent("自动放行");
  });
});

it("上键只读当前会话回放，切换后重置浏览，重开后仍可恢复", () => {
  useWorkspaceStore.setState({ activePath: "D:/history-project" });
  const item = (id: string, text: string) => ({
    kind: "user" as const,
    id,
    text,
    createdAt: "2026-11-04T00:00:00Z",
  });
  useSessionStore.setState({
    activeSessionId: "A",
    items: [item("a", "A历史")],
  });
  const view = setup();
  fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
  expect(getTextarea()).toHaveValue("A历史");
  act(() =>
    useSessionStore.setState({
      activeSessionId: "B",
      items: [item("b", "B历史")],
    }),
  );
  expect(getTextarea()).toHaveValue("");
  fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
  expect(getTextarea()).toHaveValue("B历史");
  view.unmount();
  testComposer.history.setScope("reset-test");
  testComposer.history.setScope(null);
  setup();
  fireEvent.change(getTextarea(), { target: { value: "" } });
  fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
  expect(getTextarea()).toHaveValue("B历史");
  act(() => useSessionStore.setState({ activeSessionId: null, items: [] }));
  expect(getTextarea()).toHaveValue("");
  fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
  expect(getTextarea()).toHaveValue("");
});

describe("图片粘贴和拖入", () => {
  afterEach(() => useSessionStore.setState({ supportsImages: false }));
  it("粘贴图片显示缩略图，随消息发送且清空附件", async () => {
    useSessionStore.setState({ supportsImages: true });
    const { onSend } = setup();
    await act(async () => {});
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.paste(getTextarea(), {
      clipboardData: {
        files: [new File(["image"], "shot.png", { type: "image/png" })],
      },
    });
    expect(
      await screen.findByRole("button", { name: "预览 shot.png" }),
    ).toBeInTheDocument();
    await userEvent.type(getTextarea(), "看看{Enter}");
    expect(onSend).toHaveBeenCalledWith("看看", [
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
    expect(screen.queryByRole("button", { name: "预览 shot.png" })).toBeNull();
  });
  it("不支持图片时粘贴明确提示，不添加附件", async () => {
    useSessionStore.setState({ supportsImages: false });
    setup();
    await act(async () => {});
    fireEvent.paste(getTextarea(), {
      clipboardData: {
        files: [new File(["image"], "shot.png", { type: "image/png" })],
      },
    });
    expect(
      await screen.findByText("当前 Agent 不支持图片"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览 shot.png" })).toBeNull();
  });
  it("拖入多图可逐个移除，超过五张整批拒绝", async () => {
    useSessionStore.setState({ supportsImages: true });
    setup();
    await act(async () => {});
    const files = Array.from(
      { length: 6 },
      (_, i) => new File(["image"], `${i}.png`, { type: "image/png" }),
    );
    fireEvent.drop(getTextarea(), { dataTransfer: { files } });
    expect(
      await screen.findByText("每条消息最多添加 5 张图片"),
    ).toBeInTheDocument();
    fireEvent.drop(getTextarea(), {
      dataTransfer: { files: files.slice(0, 2) },
    });
    await screen.findByRole("button", { name: "预览 1.png" });
    await userEvent.click(screen.getByRole("button", { name: "移除 0.png" }));
    expect(screen.queryByRole("button", { name: "预览 0.png" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "预览 1.png" }),
    ).toBeInTheDocument();
  });
});

it("旧版当前 Agent 的草稿完整迁入项目档位，后续切换不恢复其他旧副本", async () => {
  const project = "D:/legacy-agent-draft";
  const from = legacyNewDraftScopeKey(project, "legacy-a");
  const scope = draftScopeKey(project, null, "legacy-a");
  writeDraft(from, "旧版未发送文字");
  writeDraft(
    legacyNewDraftScopeKey(project, "legacy-b"),
    "不能复活的旧 B 草稿",
  );
  annotationDrafts.put(from, [
    {
      id: "legacy-comment",
      project,
      path: `${project}/a.md`,
      source: false,
      quote: "原文",
      prefix: "",
      suffix: "",
      offset: 0,
      revision: "r1",
      comment: "旧版批注",
    },
  ]);
  await testComposer.imageDrafts.save({
    [from]: [
      {
        name: "old.png",
        block: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      },
    ],
  });
  useWorkspaceStore.setState({ activePath: project });
  useSessionStore.setState({
    agentKey: "legacy-a",
    activeSessionId: null,
    supportsImages: true,
  });
  const view = setup();
  expect(getTextarea()).toHaveValue("旧版未发送文字");
  expect(
    await screen.findByRole("button", { name: "预览 old.png" }),
  ).toBeInTheDocument();
  await waitFor(async () => {
    expect((await testComposer.imageDrafts.load())[scope]).toHaveLength(1);
    expect((await testComposer.imageDrafts.load())[from]).toBeUndefined();
    expect(localStorage.getItem(`${scope}/project-draft-migration-v1`)).toBe(
      "done",
    );
  });
  expect(readDraft(from)).toBe("");
  expect(
    annotationDrafts.getState().drafts[scope]?.annotations[0]?.comment,
  ).toBe("旧版批注");
  expect(
    annotationDrafts.getState().drafts[from]?.annotations,
  ).toHaveLength(0);
  view.unmount();
  writeDraft(scope, "");
  await testComposer.imageDrafts.save({});
  useSessionStore.setState({ agentKey: "legacy-b" });
  setup();
  expect(getTextarea()).toHaveValue("");
});

it("取回图片和文字时保留已有草稿，会话切换隔离附件", async () => {
  useSessionStore.setState({
    supportsImages: true,
    activeSessionId: "image-a",
  });
  setup();
  await act(async () => {});
  await userEvent.type(getTextarea(), "已有草稿");
  act(() => {
    expect(testComposer.prefill("失败消息", [
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ])).toBe(true);
  });
  expect(getTextarea()).toHaveValue("已有草稿\n\n失败消息");
  expect(
    screen.getByRole("button", { name: "预览 图片 1" }),
  ).toBeInTheDocument();
  act(() => useSessionStore.setState({ activeSessionId: "image-b" }));
  expect(screen.queryByRole("button", { name: "预览 图片 1" })).toBeNull();
  act(() => useSessionStore.setState({ activeSessionId: "image-a" }));
  expect(
    screen.getByRole("button", { name: "预览 图片 1" }),
  ).toBeInTheDocument();
});

it("草稿 A→B→A 保留文字图片和批注，等待和图片不兼容时可编辑但不发送", async () => {
  const project = "D:/switch-agent-composer";
  useWorkspaceStore.setState({ activePath: project });
  useSessionStore.setState({
    agentKey: "agent-a",
    activeSessionId: null,
    supportsImages: true,
  });
  const scope = draftScopeKey(project, null, "agent-a");
  const send = vi.fn();
  const props = {
    isAgentRunning: false,
    onSend: send,
    onEnqueue: vi.fn(),
    onCancel: vi.fn(),
  };
  const view = render(<ChatInput {...props} />);
  await act(async () => {});
  act(() => {
    testComposer.prefill("未发送文字", [
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
    annotationDrafts.put(scope, [
      {
        id: "switch-comment",
        project,
        path: `${project}/a.md`,
        source: false,
        quote: "原文",
        prefix: "",
        suffix: "",
        offset: 0,
        revision: "r1",
        comment: "保留批注",
      },
    ]);
  });
  expect(
    screen.getByRole("button", { name: "预览 图片 1" }),
  ).toBeInTheDocument();
  act(() =>
    useSessionStore.setState({ agentKey: "agent-b", supportsImages: false }),
  );
  view.rerender(<ChatInput {...props} sendDisabled={true} />);
  expect(getTextarea()).toBeEnabled();
  fireEvent.change(getTextarea(), {
    target: { value: "未发送文字，继续编辑" },
  });
  fireEvent.keyDown(getTextarea(), { key: "Enter" });
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  view.rerender(<ChatInput {...props} sendDisabled={false} />);
  expect(screen.getByRole("alert")).toHaveTextContent("请移除图片或切换");
  fireEvent.keyDown(getTextarea(), { key: "Enter" });
  expect(send).not.toHaveBeenCalled();
  expect(getTextarea()).toHaveValue("未发送文字，继续编辑");
  expect(
    annotationDrafts.getState().drafts[scope]?.annotations[0]?.comment,
  ).toBe("保留批注");
  act(() =>
    useSessionStore.setState({ agentKey: "agent-a", supportsImages: true }),
  );
  expect(getTextarea()).toHaveValue("未发送文字，继续编辑");
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "预览 图片 1" }),
  ).toBeInTheDocument();
  expect(readDraft(scope)).toBe("未发送文字，继续编辑");
  await waitFor(async () =>
    expect((await testComposer.imageDrafts.load())[scope]).toHaveLength(1),
  );
  const draftKeys = Object.keys(localStorage).filter(
    (key) => key.startsWith("aaw-desktop/draft/") && key.endsWith("/__new__"),
  );
  expect(draftKeys).toEqual([scope]);
  view.unmount();
  render(<ChatInput {...props} />);
  expect(getTextarea()).toHaveValue("未发送文字，继续编辑");
  expect(
    await screen.findByRole("button", { name: "预览 图片 1" }),
  ).toBeInTheDocument();
});

const annotationOwner = createAnnotationDraftStore(webviewStorage);
const annotationDrafts = annotationOwner.service;
vi.mock("../../../src/plugins/project/ui/bindings/workspaceView.ts", async () => {
  const { workspaceViewFixture } = await import("../../helpers/workspace.ts");
  return workspaceViewFixture(() => useWorkspaceStore);
});

vi.mock(import("../../../src/plugins/project/ui/bindings/annotationDraftView.ts"), async (original) => ({
  ...(await original()),
  useAnnotationDraftService: () => annotationOwner.composer,
}));

vi.mock("../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock("../../../src/plugins/project/ui/bindings/composerView.ts", async () => {
  const { testComposer } = await import("../../helpers/composer.ts");
  return { useProjectComposer: () => testComposer };
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});
