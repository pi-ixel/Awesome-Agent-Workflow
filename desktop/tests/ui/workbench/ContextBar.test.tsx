/**
 * 顶栏（ContextBar）测试（经 ContentArea 集成渲染，覆盖条与视图
 * 主体的组合）。顶栏是全应用唯一顶栏（48px，ZCode WorkspaceHeader 形态，
 * 无全局挂件区——agent 标识与待办下拉已退役）：
 * - 会话态：Folder 钮（路径信息）+ 会话标题（workspace-title，双击改名）
 *   + 更多菜单（重命名 / 复制路径）；无 AAW 数据时无 SR 快捷；
 * - 顶栏动作排：帮助（单项「打开诊断」）/ 终端（开合底部终端面板）/
 *   分栏（开合右栏，打开即整钮不渲染）/ 窗控（非 Tauri 不渲染）；
 * - 总览态：返回按钮（有活跃会话回会话视图；无会话回落空态）+ 项目名 +
 *   路径 + 关闭项目（连接中禁闭，未连接不出现）；
 * - 设置 / 诊断全屏页：返回按钮 + 页名；
 * - 空态（未选中项目的总览）左段留空，空态引导占满下方内容区。
 *
 * 异步探测的 defaultProcessRunner 以「永不完成」的 fake 替身注入
 * （点击 SR 快捷会切到总览），保持现场稳定。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRightPanelStore } from "../../../src/stores/rightPanelStore.ts";
import ContentArea from "../../../src/ui/workbench/ContentArea.tsx";
import { useAawStatusStore } from "../../../src/stores/aawStatusStore.ts";
import { useSessionStore } from "../../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import type {
  CliRunResult,
  ProcessRunner,
} from "../../../src/aaw/processRunner.ts";

vi.mock("../../../src/aaw/tauriProcessRunner.ts", () => {
  const neverResolvingRunner: ProcessRunner = {
    run: () => new Promise<CliRunResult>(() => {}),
    exists: () => new Promise<boolean>(() => {}),
  };
  return {
    createTauriProcessRunner: () => neverResolvingRunner,
    defaultProcessRunner: neverResolvingRunner,
  };
});

// 真实连接通路以替身注入（真通路由 realRuntime.test 覆盖）：收起态新建
// 钮的测试只关心编排动作与乐观视图切换，不关心 agent 生命周期
vi.mock("../../../src/ui/realRuntime.ts", () => ({
  focusExistingSession: vi.fn(() => false),
  preloadSessionLists: vi.fn(),
  preloadSessionList: vi.fn(),
  openRealWorkspace: vi.fn(async () => "sess-new"),
  switchRealSession: vi.fn(async () => true),
  closeRealRuntime: vi.fn(async () => undefined),
  unfocusRealRuntime: vi.fn(),
  hasRunningSessions: vi.fn(() => false),
}));

import { openRealWorkspace } from "../../../src/ui/realRuntime.ts";

const PATH = "D:/dev/demo-project";
const NAME = "demo-project";

function resetAll(): void {
  window.localStorage.clear();
  vi.mocked(openRealWorkspace).mockClear();
  useRightPanelStore.setState({ projects: {} });
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
  });
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({
    activeSessionId: null,
    openingSessionId: null,
    modelLabel: null,
    approvalMode: null,
    sessionsByPath: {},
    isConnecting: false,
    isBound: false,
  });
  useWorkspaceStore.getState().closeWorkspace();
  useWorkspaceStore.getState().clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
    lastConnectError: null,
  });
  useAawStatusStore.getState().reset();
  useAawStatusStore.setState({ loader: null });
  useWorkbenchUiStore.setState({ isAawOpen: false });
}

/** 预置会话态：树选中该项目 + 活跃会话 + 已连接。 */
function seedSessionView(): void {
  useSessionStore.setState({
    activeSessionId: "sess-1",
    sessionsByPath: {
      [PATH]: [
        {
          id: "sess-1",
          title: "总结 SR-001 的进度",
          nativeTitle: "总结 SR-001 的进度",
          updatedAt: null,
        },
      ],
    },
  });
  useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
  useWorkspaceStore.setState({ activePath: PATH });
  useSessionStore.setState({ isBound: true });
}

beforeEach(() => {
  resetAll();
});

describe("ContextBar 会话态", () => {
  it("项目路径大小写和分隔符不同时仍显示会话名称", () => {
    seedSessionView();
    const sessions = useSessionStore.getState().sessionsByPath[PATH]!;
    useSessionStore.setState({
      sessionsByPath: { [PATH.toUpperCase().replaceAll("/", "\\")]: sessions },
    });
    render(<ContentArea />);
    expect(screen.getByLabelText("上下文条")).toHaveTextContent(
      "总结 SR-001 的进度",
    );
  });
  it("加载历史会话时标题显示目标会话的名称", () => {
    seedSessionView();
    useSessionStore.setState({
      activeSessionId: null,
      openingSessionId: "sess-1",
      isConnecting: true,
    });
    render(<ContentArea />);
    expect(screen.getByLabelText("上下文条")).toHaveTextContent(
      "总结 SR-001 的进度",
    );
  });
  it("会话标题在 workspace-title；路径信息由 Folder 钮承接（aria-label=目录名、title=路径）", () => {
    seedSessionView();
    render(<ContentArea />);

    expect(screen.getAllByText("总结 SR-001 的进度")[0]!).toBeInTheDocument();
    // ZCode 标题区形态：项目名小字元素删除，路径信息并入 Folder 钮
    const folderButton = screen.getByTestId("workspace-path");
    expect(folderButton).toHaveAttribute("aria-label", NAME);
    expect(folderButton).toHaveAttribute("title", PATH);
    expect(screen.queryByText(NAME)).not.toBeInTheDocument();
    // SR 快捷按钮属 AAW 面板；空态快捷列表的会话按钮不计入
    expect(
      screen.queryByRole("button", { name: "SR-001 快捷入口" }),
    ).not.toBeInTheDocument();
  });

  it("Folder 钮点击进项目总览（路径信息的承接入口）", async () => {
    seedSessionView();
    render(<ContentArea />);
    await userEvent.click(screen.getByTestId("workspace-path"));
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
  });

  it("连接中徽标为蓝点「连接中」", () => {
    seedSessionView();
    useSessionStore.setState({ isConnecting: true, isBound: false });
    render(<ContentArea />);
    expect(screen.queryByText("连接中")).not.toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("会话态不设返回按钮：进总览走项目树（顶栏不重复树导航）", () => {
    seedSessionView();
    render(<ContentArea />);
    expect(
      screen.queryByRole("button", { name: "返回总览" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContextBar 顶栏动作排（ZCode WorkspaceHeaderActionSection 形态）", () => {
  it("更多菜单：重命名进入行内编辑（复用双击改名状态流）；复制路径写剪贴板", async () => {
    seedSessionView();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ContentArea />);

    await userEvent.click(screen.getByTestId("workspace-more-button"));
    const menu = screen.getByRole("menu", { name: "更多" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "重命名" }),
    );
    expect(
      screen.getByRole("textbox", { name: "会话名称" }),
    ).toBeInTheDocument();

    // Esc 退出编辑后再验复制路径
    await userEvent.type(
      screen.getByRole("textbox", { name: "会话名称" }),
      "{Escape}",
    );
    await userEvent.click(screen.getByTestId("workspace-more-button"));
    const menuAgain = screen.getByRole("menu", { name: "更多" });
    await userEvent.click(
      within(menuAgain).getByRole("menuitem", { name: "复制路径" }),
    );
    expect(writeText).toHaveBeenCalledWith(PATH);
  });

  it("terminal-toggle：aria-pressed 翻转并开合底部终端面板（面板关闭钮同路）", async () => {
    seedSessionView();
    render(<ContentArea />);
    const toggle = screen.getByTestId("terminal-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(true);

    await userEvent.click(screen.getByTestId("terminal-close-button"));
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(false);
  });

  it("side-pane-toggle：点钮打开右栏；右栏打开时整钮不渲染（ZCode :75-82），右栏 ✕ 收起后钮回来", async () => {
    seedSessionView();
    render(<ContentArea />);
    await userEvent.click(screen.getByTestId("side-pane-toggle"));
    // 右栏打开（store 驱动，键经 pathKey 归一化小写）
    expect(
      useRightPanelStore.getState().projects["d:/dev/demo-project"]?.open,
    ).toBe(true);
    expect(screen.queryByTestId("side-pane-toggle")).not.toBeInTheDocument();

    // 右栏自带 ✕ 收起钮（RightPanel :276-282）
    await userEvent.click(
      screen.getByRole("button", { name: "收起右侧工具栏" }),
    );
    expect(screen.getByTestId("side-pane-toggle")).toBeInTheDocument();
  });

  it("help-menu-button：单项「打开诊断」开设置覆盖层（诊断并入设置页签）", async () => {
    seedSessionView();
    render(<ContentArea />);
    await userEvent.click(screen.getByTestId("help-menu-button"));
    const menu = screen.getByRole("menu", { name: "帮助菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "打开诊断" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  });

  it("窗控三钮的 testid 挂点：非 Tauri 测试环境不渲染（窗控行为见 WindowControls.test）", () => {
    seedSessionView();
    render(<ContentArea />);
    expect(
      screen.queryByTestId("window-control-minimize"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("window-control-maximize"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("window-control-close"),
    ).not.toBeInTheDocument();
  });
});

describe("ContextBar 总览态", () => {
  it("返回按钮 + 项目名 + 路径（mono 小字）；已连接时显示「关闭项目」次级按钮", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({ isBound: true });
    render(<ContentArea />);

    expect(screen.getByRole("heading", { name: NAME })).toBeInTheDocument();
    expect(screen.getByTitle(PATH)).toHaveTextContent(PATH);
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭项目" }),
    ).toBeInTheDocument();
  });

  it("关闭项目按钮在连接中禁闭；项目未打开时不出现", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    const { rerender } = render(<ContentArea />);
    // 未打开：无关闭入口
    expect(
      screen.queryByRole("button", { name: "关闭项目" }),
    ).not.toBeInTheDocument();

    // 连接中：按钮出现但禁闭
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({ isConnecting: true });
    rerender(<ContentArea />);
    expect(screen.getByRole("button", { name: "关闭项目" })).toBeDisabled();
  });

  it("返回：该项目有活跃会话时回会话视图", async () => {
    seedSessionView();
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(useWorkbenchUiStore.getState().treeView).toBe("session");
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
  });

  it("返回：无活跃会话时清空上下文回落空态（空态只有全局区，无返回按钮）", async () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    const ui = useWorkbenchUiStore.getState();
    expect(ui.contextPath).toBeNull();
    expect(ui.treeView).toBe("project-overview");
    // 空态：无上下文部分（无标题、无返回按钮），顶栏也不再有全局挂件
    // （agent 标识 / 待办已退役），空态引导占满下方内容区
    expect(
      screen.queryByRole("button", { name: "返回" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("上下文条")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "待办" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });
});

describe("ContextBar 连接失败横幅与徽标（P0-1）", () => {
  const FAILURE_MESSAGE =
    "连接 agent 失败：chrys.exe 不存在，请在设置中检查 agent 可执行路径";

  it("会话态：失败态展示错误横幅 + 红色「失败」徽标；「打开设置」切设置页", async () => {
    seedSessionView();
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    render(<ContentArea />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/连接失败：连接 agent 失败/);
    expect(banner).toHaveTextContent(/请在设置中检查 agent 可执行路径/);
    // 连接徽标进入失败态（badge 文字）
    expect(screen.queryByText("失败")).not.toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();

    await userEvent.click(
      within(banner).getByRole("button", { name: "打开设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  });

  it("项目总览态同样展示错误横幅；切换目标后不再显示旧项目失败", () => {
    useWorkbenchUiStore.setState({
      treeView: "project-overview",
      contextPath: PATH,
    });
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    const { rerender } = render(<ContentArea />);
    expect(screen.getByRole("alert")).toHaveTextContent(/连接失败/);

    // 切到另一个项目上下文：旧项目的失败横幅不跟随
    useWorkbenchUiStore.setState({ contextPath: "D:/dev/other-project" });
    rerender(<ContentArea />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("横幅可关闭：关闭后横幅退场且失败态清除", async () => {
    seedSessionView();
    useWorkspaceStore.getState().reportConnectFailure(PATH, FAILURE_MESSAGE);
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().lastConnectError).toBeNull();
  });
});

describe("ContextBar 全屏页", () => {
  it("设置全屏页：页名 + 返回按钮，返回关闭覆盖层", async () => {
    useWorkbenchUiStore.setState({ overlay: "settings" });
    render(<ContentArea />);

    // 页名在上下文条内（设置页自身的 section 标题也含「设置」二字，
    // 用上下文条 landmark 收窄查询）
    const bar = screen.getByLabelText("上下文条");
    expect(
      within(bar).getByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });

});

describe("ContextBar 收起态顶栏新建入口（ZCode DesktopTopOverlay 强制显示位）", () => {
  it("侧栏收起 + 会话视图：顶栏左端出现「新建会话」钮，点击直接在当前项目开新会话", async () => {
    seedSessionView();
    useWorkbenchUiStore.setState({ sidebarCollapsed: true });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));
    // 直开语义（ZCode 顶栏新建任务）：在当前项目 forceNew 起新会话，
    // 乐观切到会话视图（连接替身成功，无回滚）
    expect(openRealWorkspace).toHaveBeenCalledWith(PATH, { forceNew: true });
    expect(useWorkbenchUiStore.getState().treeView).toBe("session");
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
    // 入口本身不改变收起态（ZCode 收起态保留入口的本意就是不展开侧栏）
    expect(useWorkbenchUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it("侧栏收起 + 空态：点击先展开侧栏再打开【+】面板（面板锚在树体顶部）", async () => {
    useWorkbenchUiStore.setState({ sidebarCollapsed: true });
    render(<ContentArea />);

    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));
    const ui = useWorkbenchUiStore.getState();
    expect(ui.sidebarCollapsed).toBe(false);
    expect(ui.treeViewMode).toBe("projects");
    expect(ui.isAddPanelOpen).toBe(true);
  });

  it("侧栏展开时不渲染（ZCode isNewTaskButtonVisible = !isSidebarVisible 同款）", () => {
    seedSessionView();
    render(<ContentArea />);
    expect(
      screen.queryByRole("button", { name: "新建会话" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContextBar 会话改名（双击行内编辑）", () => {
  it("双击进入编辑，回车提交：顶栏与树缓存即时更新", async () => {
    seedSessionView();
    render(<ContentArea />);

    await userEvent.dblClick(screen.getAllByText("总结 SR-001 的进度")[0]!);
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await userEvent.clear(input);
    await userEvent.type(input, "我的会话名{Enter}");

    // 展示立即更新（顶栏 + 树缓存同源）
    expect(screen.getAllByText("我的会话名")[0]!).toBeInTheDocument();
    const entry = useSessionStore
      .getState()
      .sessionsByPath[PATH]?.find((session) => session.id === "sess-1");
    expect(entry?.title).toBe("我的会话名");
  });

  it("Esc 取消不提交；清空提交恢复原生名，悬停可见原生名", async () => {
    seedSessionView();
    render(<ContentArea />);

    // Esc 取消
    await userEvent.dblClick(screen.getAllByText("总结 SR-001 的进度")[0]!);
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await userEvent.clear(input);
    await userEvent.type(input, "半截输入{Escape}");
    expect(screen.getAllByText("总结 SR-001 的进度")[0]!).toBeInTheDocument();

    // 手动改名后悬停提示原生名；清空提交恢复
    await userEvent.dblClick(screen.getAllByText("总结 SR-001 的进度")[0]!);
    await userEvent.clear(screen.getByRole("textbox", { name: "会话名称" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "会话名称" }),
      "手动名{Enter}",
    );
    expect(
      screen.getByTitle(/总结 SR-001 的进度（双击重命名/),
    ).toBeInTheDocument();

    await userEvent.dblClick(screen.getAllByText("手动名")[0]!);
    await userEvent.clear(screen.getByRole("textbox", { name: "会话名称" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "会话名称" }),
      "{Enter}",
    );
    expect(screen.getAllByText("总结 SR-001 的进度")[0]!).toBeInTheDocument();
  });
});
