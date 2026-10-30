import type { ReactNode } from "react";
/**
 * 树状视图 + 内容区交互测试（App 级）：
 * - 点项目节点进总览（含自动健康检查）；
 * - 点会话子节点：内容区**立即**切到会话视图（乐观，连接中即加载态），
 *   连接与切换在后台完成（mock realRuntime），失败回滚点击前视图；
 * - 连接徽标三态（树行尾为纯点形态，语义在 aria-label）与健康徽标；
 * - 树展开 / 折叠（默认展开有会话的项目）；
 * - 「+ 新会话」直接开一条空会话（不强制走 AAW 入口向导）；
 * - 会话内 AAW 面板：SR 快捷 / AAW 按钮开合，启动分段可发首条 prompt；
 * - 【+】面板两个 tab：新建会话开空会话、添加项目走目录对话框；
 * - 侧边栏收起 / 展开（树列整体隐藏、图标窄栏常驻、拖宽热区隐藏、
 *   持久化；窄栏交互细项见 workbench/IconRail.test.tsx）；
 * - 会话视角：跨项目拍平按 updatedAt 降序、点会话自动重连、空态、
 *   视角持久化。
 *
 * realRuntime 以 vi.fn 替身注入（真实通路由 realRuntime.test 覆盖）；
 * plugin-dialog 打桩；健康检查 runner 永不完成，保持现场稳定。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { open as mockOpen } from "@tauri-apps/plugin-dialog";

import App from "../../src/App";
import { useRightPanelStore } from "../../src/stores/rightPanelStore.ts";
import { useApprovalStore } from "../../src/stores/approvalStore.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import {
  openRealWorkspace,
  switchRealSession,
} from "../../src/ui/realRuntime.ts";
import { resetSessionOpenQueueForTests } from "../../src/ui/workbench/sessionEntry.ts";
import type {
  CliRunResult,
  ProcessRunner,
} from "../../src/aaw/processRunner.ts";

// Startup timing has its own tests; these exercise the interactive workspace.
vi.mock("../../src/ui/StartupGate.tsx", () => ({
  StartupGate: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../../src/ui/realRuntime.ts", () => ({
  focusExistingSession: vi.fn(() => false),
  liveRuntimeSessionIds: vi.fn(() => new Set()),
  busyRuntimeSessionIds: vi.fn(() => new Set()),
  attachSessionPreloading: vi.fn(() => () => {}),
  preloadSessionLists: vi.fn(),
  preloadSessionList: vi.fn(),
  openRealWorkspace: vi.fn(),
  switchRealSession: vi.fn(),
  closeRealRuntime: vi.fn(),
  unfocusRealRuntime: vi.fn(),
  hasRunningSessions: vi.fn(() => false),
}));

vi.mock("../../src/aaw/tauriProcessRunner.ts", () => {
  const neverResolvingRunner: ProcessRunner = {
    run: () => new Promise<CliRunResult>(() => {}),
    exists: () => new Promise<boolean>(() => {}),
  };
  return {
    createTauriProcessRunner: () => neverResolvingRunner,
    defaultProcessRunner: neverResolvingRunner,
  };
});

const PATH = "D:/dev/demo-project";
const NAME = "demo-project";
const PATH_B = "D:/dev/other-project";
const NAME_B = "other-project";

function resetAll(): void {
  window.localStorage.clear();
  useRightPanelStore.setState({ projects: {} });
  // 串行队列是模块级状态：上个用例遗留的挂起编排不拖累下一个
  resetSessionOpenQueueForTests();
  vi.mocked(openRealWorkspace).mockReset();
  vi.mocked(switchRealSession).mockReset();
  vi.mocked(mockOpen).mockReset();
  useApprovalStore.getState().clear();
  const session = useSessionStore.getState();
  session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    openingSessionId: null,
    modelLabel: null,
    approvalMode: null,
    sessionsByPath: {},
    isConnecting: false,
    isBound: false,
  });
  const workspace = useWorkspaceStore.getState();
  workspace.closeWorkspace();
  workspace.clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
  });
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
    isAawOpen: false,
  });
}

/** 预置两个最近项目：demo-project 两条历史会话、other-project 一条
 *  （updatedAt 更新），供会话视角的拍平排序与跨项目切换用。 */
function seedProjectWithSessions(): void {
  const sessions = [
    { id: "sess-1", title: "会话 · 旧任务", updatedAt: null },
    { id: "sess-2", title: "会话 · 更早任务", updatedAt: null },
  ];
  useWorkspaceStore.setState({
    recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
  });
  useSessionStore.setState({
    sessions,
    sessionsByPath: { [PATH]: sessions },
  });
}

/** 预置一个没有任何历史会话的项目（新加项目 / 冷启动的树的形态）。 */
function seedProjectNoSessions(): void {
  useWorkspaceStore.setState({
    recentWorkspaces: [{ path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" }],
  });
  useSessionStore.setState({ sessions: [], sessionsByPath: {} });
}

/**
 * 模拟一次成功的真实连接：openRealWorkspace 落定会话 id、建立下行绑定，
 * 并回填该项目会话列表（startNewSession 以 isBound 判定连接成败）。
 */
function mockConnect(path: string, sessionId = "sess-1"): void {
  vi.mocked(openRealWorkspace).mockImplementation((target) => {
    if (target !== path) {
      return Promise.resolve(null);
    }
    useSessionStore.getState().bindSession({
      prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
      cancel: () => {},
    });
    useSessionStore
      .getState()
      .setSessions(useSessionStore.getState().sessionsByPath[path] ?? [], path);
    return Promise.resolve(sessionId);
  });
}

function seedSecondProjectWithSession(): void {
  useWorkspaceStore.setState({
    recentWorkspaces: [
      { path: PATH, lastOpenedAt: "2026-10-20T10:00:00Z" },
      { path: PATH_B, lastOpenedAt: "2026-10-20T09:00:00Z" },
    ],
  });
  useSessionStore.setState((state) => ({
    sessionsByPath: {
      ...state.sessionsByPath,
      [PATH_B]: [
        {
          id: "sess-b1",
          title: "会话 · 他项目任务",
          updatedAt: "2026-10-21T08:30:00Z",
        },
      ],
    },
  }));
}

/** 打开【+】弹出面板并切到指定 tab（默认 tab 无需切换）。
 *  【+】现住各分组标题行尾（ZCode PurposeSections 段头动作位），两个分组
 *  各有一枚，点第一枚（收藏组）。 */
async function openAddPanel(tab?: "添加项目"): Promise<void> {
  await userEvent.click(
    screen.getAllByRole("button", { name: "新建会话或添加项目" })[0]!,
  );
  const panel = screen.getByLabelText("新建会话面板");
  expect(panel).toBeInTheDocument();
  if (tab !== undefined) {
    await userEvent.click(within(panel).getByRole("tab", { name: tab }));
  }
}

/** 切到会话视角：列表头「切换视角」下拉的 radio 项（ViewModeSegmented
 *  分段控件已退役，切换入口收敛为 ZCode ProjectSidebarListHeader 形态）。 */
async function switchToSessionsView(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "切换视角" }));
  const viewMenu = screen.getByRole("menu", { name: "切换视角" });
  await userEvent.click(
    within(viewMenu).getByRole("menuitemradio", { name: "最近会话" }),
  );
}

beforeEach(() => {
  resetAll();
});

/** 树内会话行定位：内容空态的项目会话快捷列表与树同名，须收敛到树内。 */
function treeSession(name: RegExp | string): HTMLElement {
  return within(screen.getByLabelText("项目树")).getByRole("button", {
    name,
  });
}
describe("项目树 → 项目总览", () => {
  it("点项目节点：内容区切到该项目总览；检查不自动发起（手动「重新检查」）", async () => {
    seedProjectWithSessions();
    render(<App />);
    // 名字按钮带 title=路径，与收藏 / 移除按钮区分
    await userEvent.click(screen.getByRole("button", { name: "工作流" }));

    expect(screen.getByRole("heading", { name: NAME })).toBeInTheDocument();
    // 检查通过过的不会自己坏掉：进总览不自动重查；未检查态不渲染 chip
    // （行上只有可手动发起的「重新检查」）；工作流状态单点渲染
    expect(screen.queryByText("未检查")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
    expect(
      screen.getByRole("region", { name: "工作流状态" }),
    ).toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
  });

  it("【+】面板「添加项目」tab：目录对话框选择后进树并选中进总览", async () => {
    vi.mocked(mockOpen).mockResolvedValue("D:/dev/new-project");
    render(<App />);
    await openAddPanel("添加项目");

    await userEvent.click(screen.getByRole("button", { name: "添加项目…" }));
    expect(
      await screen.findByRole("heading", { name: "new-project" }),
    ).toBeInTheDocument();
    // 添加成功：面板关闭并选中新项目进总览
    expect(screen.queryByLabelText("新建会话面板")).not.toBeInTheDocument();
    const tree = screen.getByLabelText("项目树");
    expect(within(tree).getByTitle("D:/dev/new-project")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().selectedPath).toBe(
      "D:/dev/new-project",
    );
  });

  it("置顶交互：右键菜单「置顶」后项目节点进置顶带（无分组头），「取消置顶」移回", async () => {
    seedProjectWithSessions();
    render(<App />);
    const recentSection = screen.getByLabelText("项目");
    expect(within(recentSection).getByTitle(PATH)).toBeInTheDocument();

    // 行尾常驻星按钮已收进右键菜单（ZCode TaskActionMenu 形态）：
    // 右键项目行 → 菜单「置顶」
    fireEvent.contextMenu(within(recentSection).getByTitle(PATH));
    const pinMenu = screen.getByRole("menu", { name: "项目菜单" });
    await userEvent.click(
      within(pinMenu).getByRole("menuitem", { name: "置顶" }),
    );
    // 置顶后「最近打开」组内不再有该项目：分组头恒在（ZCode 分区结构
    // 不随内容消失），空组只是没有行；置顶行带无分组头（ZCode
    // SortableProjects 形态），按 aria-label「置顶」定位
    const recentSectionAfter = screen.getByLabelText("项目");
    expect(
      within(recentSectionAfter).queryByTitle(PATH),
    ).not.toBeInTheDocument();
    const pinnedBand = screen.getByLabelText("置顶");
    expect(within(pinnedBand).getByTitle(PATH)).toBeInTheDocument();

    // 再经右键菜单「取消置顶」移回（置顶带随之消失——无分组头）
    fireEvent.contextMenu(within(pinnedBand).getByTitle(PATH));
    const unpinMenu = screen.getByRole("menu", { name: "项目菜单" });
    await userEvent.click(
      within(unpinMenu).getByRole("menuitem", { name: "取消置顶" }),
    );
    expect(screen.queryByLabelText("置顶")).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("项目")).getByTitle(PATH),
    ).toBeInTheDocument();
  });

  it("「从列表移除」经右键菜单清掉树节点；内容区正停留该工程时回落空态", async () => {
    seedProjectWithSessions();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "工作流" }));
    expect(screen.getByRole("heading", { name: NAME })).toBeInTheDocument();

    const tree = screen.getByLabelText("项目树");
    fireEvent.contextMenu(within(tree).getByTitle(PATH));
    const menu = screen.getByRole("menu", { name: "项目菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "从列表移除" }),
    );
    expect(screen.queryByTitle(PATH)).not.toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().contextPath).toBeNull();
  });
});

describe("项目树 → 会话子节点", () => {
  it("项目未连接：冷连接直接载入目标会话，内容区切到会话视图", async () => {
    seedProjectWithSessions();
    vi.mocked(openRealWorkspace).mockResolvedValue("sess-1");
    vi.mocked(switchRealSession).mockResolvedValue(true);
    render(<App />);

    await userEvent.click(treeSession(/会话 · 旧任务/));

    // 未连接 → 冷连接并点名载入目标会话（单次回放，别的会话不涌进
    // 视图）；activePath 落地后 RealSessionRuntime 的装配 effect 会对
    // 同路径补一次幂等调用
    expect(openRealWorkspace).toHaveBeenCalledWith(PATH, {
      sessionId: "sess-1",
    });
    expect(openRealWorkspace).not.toHaveBeenCalledWith(PATH, {
      listOnly: true,
    });
    expect(switchRealSession).toHaveBeenCalledWith("sess-1", PATH);
    expect(useWorkspaceStore.getState().activePath).toBe(PATH);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-1");
    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();

    // 已连接同一项目：再点另一会话不再重连，只切换会话
    await userEvent.click(treeSession(/会话 · 更早任务/));
    expect(openRealWorkspace).toHaveBeenCalledTimes(1);
    expect(switchRealSession).toHaveBeenLastCalledWith("sess-2", PATH);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-2");
  });

  it("切换失败（会话过期等）：乐观切到的会话视图回滚，聚焦保持原样", async () => {
    seedProjectWithSessions();
    vi.mocked(switchRealSession).mockResolvedValue(false);
    render(<App />);

    await userEvent.click(treeSession(/会话 · 旧任务/));

    expect(switchRealSession).toHaveBeenCalledWith("sess-1", PATH);
    // 失败即回滚：乐观切进来的会话视图退场，回到点击前的总览
    await waitFor(() => {
      expect(screen.queryByLabelText("会话视图")).not.toBeInTheDocument();
    });
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it("点击会话立即有反馈：连接还没完成，会话视图与目标行高亮已就位", async () => {
    seedProjectWithSessions();
    // 连接永不完成：最慢的真实场景——反馈也必须即时
    //（置连接中是真实 openRealWorkspace 的第一件事，替身照做）
    vi.mocked(openRealWorkspace).mockImplementation(() => {
      useSessionStore.getState().setConnecting(true);
      return new Promise(() => {});
    });
    render(<App />);

    await userEvent.click(treeSession(/会话 · 旧任务/));

    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();
    expect(screen.getByText(/正在连接 agent/)).toBeInTheDocument();
    // 乐观高亮：activeSessionId 还没落，目标行已呈选中态
    expect(
      screen.getByRole("button", { name: /会话 · 旧任务/ }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("先会话后项目：回总览后会话行退光，项目行是唯一选中（双焦点锁定）", async () => {
    seedProjectWithSessions();
    vi.mocked(openRealWorkspace).mockResolvedValue("sess-1");
    vi.mocked(switchRealSession).mockResolvedValue(true);
    render(<App />);
    const SELECTED_CLASS = "bg-(--color-selected)";

    // 先进会话视图（会话行亮）
    await userEvent.click(treeSession(/会话 · 旧任务/));
    expect(treeSession(/会话 · 旧任务/).closest("li")!.className).toContain(
      SELECTED_CLASS,
    );

    // 再点项目回总览：会话行必须退光——activeSessionId 未清，
    // 但高亮由「内容区正在显示谁」门控，全树只允许一个答案
    await userEvent.click(screen.getByRole("button", { name: "工作流" }));
    expect(screen.queryByLabelText("会话视图")).not.toBeInTheDocument();
    expect(treeSession(/会话 · 旧任务/)).not.toHaveAttribute("aria-current");
    expect(
      (screen.getAllByTitle(PATH)[0] as HTMLElement).closest("div")?.className,
    ).toContain(SELECTED_CLASS);
  });

  it("当前打开的会话子节点高亮（aria-current）", () => {
    seedProjectWithSessions();
    useSessionStore.setState({ activeSessionId: "sess-1" });
    // 高亮门控：内容区正在显示该会话（会话视图）才亮
    useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
    render(<App />);
    const activeNode = screen.getByRole("button", {
      name: /会话 · 旧任务/,
    });
    expect(activeNode).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: /会话 · 更早任务/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("会话视图下只有会话行呈选中态：项目行不再同时亮（父节点不算选中）", async () => {
    seedProjectWithSessions();
    vi.mocked(openRealWorkspace).mockResolvedValue("sess-1");
    vi.mocked(switchRealSession).mockResolvedValue(true);
    render(<App />);
    const SELECTED_CLASS = "bg-(--color-selected)";

    // 先选中该项目（总览态 → 项目行是唯一选中项）
    await userEvent.click(screen.getByRole("button", { name: "工作流" }));
    expect(
      (screen.getAllByTitle(PATH)[0] as HTMLElement).closest("div")?.className,
    ).toContain(SELECTED_CLASS);

    // 进会话视图：选中落点转到会话行，项目行退回普通行
    await userEvent.click(treeSession(/会话 · 旧任务/));
    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();
    expect(treeSession(/会话 · 旧任务/).closest("li")!.className).toContain(
      SELECTED_CLASS,
    );
    expect(
      screen.getAllByTitle(PATH)[0]?.closest("div")?.className,
    ).not.toContain(SELECTED_CLASS);
  });
});

describe("项目树徽标与展开", () => {
  it("连接徽标（树行尾点形态）：未连接不渲染徽标（行尾无状态点）", () => {
    seedProjectWithSessions();
    render(<App />);
    // 「未连接」是列表里绝大多数项目的常态：不渲染灰点，避免逐行噪声
    expect(screen.queryByLabelText("未连接")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("连接中")).not.toBeInTheDocument();
  });

  it("连接状态点已移除：项目行任何连接态都不呈现（模型 a）", () => {
    seedProjectWithSessions();
    useWorkspaceStore.setState({ activePath: PATH });
    useSessionStore.setState({ isBound: true, isConnecting: true });
    render(<App />);
    expect(screen.queryByLabelText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("连接中")).not.toBeInTheDocument();
  });
  it("健康徽标：全部通过显示 ✓n/n；有警告/失败显示 ⚠；无结果不显示", () => {
    seedProjectWithSessions();
    // 健康报告按 selectedPath 防过期覆盖，先命中该项目
    useWorkspaceStore.setState({ selectedPath: PATH });
    const { rerender } = render(<App />);
    expect(screen.queryByText("✓2/2")).not.toBeInTheDocument();
    expect(screen.queryByText("⚠")).not.toBeInTheDocument();

    useWorkspaceStore.getState().applyHealthReport(PATH, [
      {
        id: "chrys",
        label: "chrys",
        status: "pass",
        summary: "ok",
        fixHint: "",
        durationMs: 1,
      },
      {
        id: "uv",
        label: "uv",
        status: "pass",
        summary: "ok",
        fixHint: "",
        durationMs: 1,
      },
    ]);
    rerender(<App />);
    expect(screen.getByText("✓2/2")).toBeInTheDocument();

    useWorkspaceStore.getState().applyHealthReport(PATH, [
      {
        id: "chrys",
        label: "chrys",
        status: "pass",
        summary: "ok",
        fixHint: "",
        durationMs: 1,
      },
      {
        id: "uv",
        label: "uv",
        status: "warn",
        summary: "旧版本",
        fixHint: "",
        durationMs: 1,
      },
    ]);
    rerender(<App />);
    expect(screen.queryByText("✓2/2")).not.toBeInTheDocument();
    expect(screen.getByText("⚠")).toBeInTheDocument();
  });

  it("默认展开有会话的项目；可折叠再展开", async () => {
    seedProjectWithSessions();
    render(<App />);
    // 默认展开：会话子节点可见
    expect(
      screen.getByRole("button", { name: /会话 · 旧任务/ }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByLabelText("项目树")).getByTitle(PATH),
    );
    expect(
      screen.queryByRole("button", { name: /会话 · 旧任务/ }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(screen.getByLabelText("项目树")).getByTitle(PATH),
    );
    expect(
      screen.getByRole("button", { name: /会话 · 旧任务/ }),
    ).toBeInTheDocument();
  });

  it("单击项目标题：收起 / 展开目录（折叠入口收敛到标题，行尾让位动作栏）", async () => {
    seedProjectWithSessions();
    render(<App />);
    expect(
      screen.getByRole("button", { name: /会话 · 旧任务/ }),
    ).toBeInTheDocument();

    const title = within(screen.getByLabelText("项目树")).getByTitle(PATH);
    await userEvent.click(title);
    expect(
      screen.queryByRole("button", { name: /会话 · 旧任务/ }),
    ).not.toBeInTheDocument();

    await userEvent.click(title);
    expect(
      screen.getByRole("button", { name: /会话 · 旧任务/ }),
    ).toBeInTheDocument();
  });
});

describe("项目树 → 新会话（普通会话）", () => {
  /** 项目行内的「新建会话」钮（行尾动作栏）：顶部新建行（NewTaskButtonGroup）
   *  与行尾动作栏同名，须收敛到项目行 li 内定位。 */
  function rowNewSessionButton(): HTMLElement {
    const row = within(screen.getByLabelText("项目")).getByTitle(PATH);
    const li = row.closest("li");
    if (li === null) {
      throw new Error("项目行 li 不存在");
    }
    return within(li as HTMLElement).getByRole("button", {
      name: "新建会话",
    });
  }

  it("点「+ 新会话」：真开一条空会话（forceNew），不经过 AAW 入口向导", async () => {
    seedProjectWithSessions();
    mockConnect(PATH);
    render(<App />);
    await userEvent.click(rowNewSessionButton());

    // forceNew 是「新建」与「打开历史」的分水岭：不做它就会落进上次对话
    await waitFor(() => {
      expect(openRealWorkspace).toHaveBeenCalledWith(PATH, { forceNew: true });
    });
    expect(await screen.findByLabelText("会话视图")).toBeInTheDocument();
    // 未连接先连接：activePath 落地
    expect(useWorkspaceStore.getState().activePath).toBe(PATH);
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
    // 向导不是入口：它只是会话内 AAW 面板里的一个可选分段
    expect(screen.queryByLabelText("入口启动向导")).not.toBeVisible();
  });

  it("没有历史会话的项目也可以展开并新建（空项目在树上不是死路）", async () => {
    seedProjectNoSessions();
    mockConnect(PATH);
    render(<App />);

    // 无历史：默认收起；展开后行尾动作栏即有「新建会话」——空项目不是死路
    await userEvent.click(
      within(screen.getByLabelText("项目树")).getByTitle(PATH),
    );
    expect(rowNewSessionButton()).toBeInTheDocument();
  });

  it("连接失败：会话视图回滚落总览，失败原因交给上下文条横幅", async () => {
    seedProjectWithSessions();
    vi.mocked(openRealWorkspace).mockImplementation((path) => {
      useWorkspaceStore
        .getState()
        .reportConnectFailure(path, "chrys.exe 不存在");
      return Promise.resolve(null);
    });
    render(<App />);
    await userEvent.click(rowNewSessionButton());

    // 失败即回滚：乐观切进来的会话视图退场，落在总览（修复入口在那儿）
    await waitFor(() => {
      expect(screen.queryByLabelText("会话视图")).not.toBeInTheDocument();
    });
    // 工作流工具未配置也可独立显示告警；这里仅验证连接失败横幅。
    expect(
      (await screen.findByText(/连接失败：/)).closest('[role="alert"]'),
    ).toHaveTextContent("chrys.exe 不存在");
  });
});

describe("会话内 AAW 面板", () => {
  /** 落到会话视图（项目已连接 + 有绑定）。 */
  function seedSessionView(): void {
    seedProjectWithSessions();
    useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
    useWorkspaceStore.setState({ activePath: PATH, selectedPath: PATH });
    useSessionStore.setState({ activeSessionId: "sess-1" });
    useSessionStore.getState().bindSession({
      prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
      cancel: () => {},
    });
  }

  it("默认收起：AAW 是增强不是前置，对话先占主区；顶栏分栏钮展开", async () => {
    seedSessionView();
    // 分栏钮重开右栏时回到记忆的上次分段：预置 AAW 为上次分段（PanelButtons
    // 逐工具按钮已退役，右栏入口收敛为顶栏 side-pane-toggle）
    useRightPanelStore.setState({
      projects: {
        "d:/dev/demo-project": {
          open: false,
          width: 420,
          active: "aaw",
          tabs: [],
        },
      },
    });
    render(<App />);

    expect(screen.queryByLabelText("AAW 面板")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("side-pane-toggle"));
    expect(screen.getByLabelText("AAW 面板")).toBeInTheDocument();
    // 对话仍在：面板是右侧并列栏，不是替换
    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "收起右侧工具栏" }),
    );
    expect(screen.queryByLabelText("AAW 面板")).not.toBeInTheDocument();
  });

  it("「启动」分段：向导生成首条 prompt 直接交给当前会话发送", async () => {
    seedSessionView();
    // 预置 AAW 为右栏上次分段：分栏钮（side-pane-toggle）直接回到 AAW 面板
    useRightPanelStore.setState({
      projects: {
        "d:/dev/demo-project": {
          open: false,
          width: 420,
          active: "aaw",
          tabs: [],
        },
      },
    });
    let promptCalls = 0;
    useSessionStore.getState().bindSession({
      prompt: (prompt) => {
        promptCalls += 1;
        expect(prompt).toContain("SR-009");
        return Promise.resolve({ stopReason: "end_turn" as const });
      },
      cancel: () => {},
    });
    render(<App />);

    await userEvent.click(screen.getByTestId("side-pane-toggle"));
    await userEvent.click(screen.getByRole("tab", { name: "启动" }));
    await userEvent.click(screen.getByLabelText(/dev 个人轻量/));
    await userEvent.click(
      screen.getByRole("button", { name: "下一步：填写变量" }),
    );
    await userEvent.type(screen.getByLabelText("SR 编号"), "SR-009");
    await userEvent.type(
      screen.getByLabelText("一句话需求"),
      "给设置页加深色模式开关",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "下一步：确认发送" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "交给会话发送" }));

    await waitFor(() => expect(promptCalls).toBe(1));
    // 已在会话视图：不跳页，只是把首条 prompt 送进对话
    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();
  });
});

describe("【+】弹出面板", () => {
  it("默认「新建会话」tab 列出已知项目（含连接徽标）；点项目关面板并开新会话", async () => {
    seedProjectWithSessions();
    mockConnect(PATH);
    render(<App />);
    await openAddPanel();

    // 已知项目（收藏 + 最近）出现在面板里；未连接的项目不带状态徽标
    //（「未连接」不逐行重复，只在有连接状态时才出现）
    const panel = screen.getByLabelText("新建会话面板");
    expect(within(panel).getByTitle(PATH)).toBeInTheDocument();
    expect(within(panel).queryByLabelText("未连接")).not.toBeInTheDocument();
    // 触发按钮呈展开态（【+】在分组标题行尾，两个分组各一枚，取第一枚）
    expect(
      screen.getAllByRole("button", { name: "新建会话或添加项目" })[0]!,
    ).toHaveAttribute("aria-expanded", "true");

    // 点项目行：关面板，内容区切到该项目上下文的入口向导
    await userEvent.click(within(panel).getByTitle(PATH));
    expect(screen.queryByLabelText("新建会话面板")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "新建会话或添加项目" })[0]!,
    ).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByLabelText("会话视图")).toBeInTheDocument();
    expect(useWorkbenchUiStore.getState().contextPath).toBe(PATH);
  });

  it("点面板外部与按 Esc 关闭；无已知项目时新建会话 tab 呈空态提示", async () => {
    render(<App />);
    const trigger = screen.getAllByRole("button", {
      name: "新建会话或添加项目",
    })[0]!;
    await userEvent.click(trigger);
    const panel = screen.getByLabelText("新建会话面板");
    expect(within(panel).getByText(/暂无已知项目/)).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByLabelText("新建会话面板")).not.toBeInTheDocument();

    // 再开一次，按 Esc 关闭
    await userEvent.click(trigger);
    expect(screen.getByLabelText("新建会话面板")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("新建会话面板")).not.toBeInTheDocument();
  });

  it("「添加项目」tab：对话框取消返回 null 时提示重试且面板不关", async () => {
    vi.mocked(mockOpen).mockResolvedValue(null);
    render(<App />);
    await openAddPanel("添加项目");

    await userEvent.click(screen.getByRole("button", { name: "添加项目…" }));
    expect(
      await screen.findByText(/目录选择不可用或已取消/),
    ).toBeInTheDocument();
    // 取消不关面板：提示留在面板内供重试
    expect(screen.getByLabelText("新建会话面板")).toBeInTheDocument();
  });
});

describe("侧边栏收起与展开", () => {
  it("点树带开关收起：树列整体隐藏（拖宽热区一并隐藏），开关移入顶栏左端；再点展开并持久化", async () => {
    seedProjectWithSessions();
    render(<App />);
    const tree = screen.getByLabelText("项目树");

    // 收起的入口在树列顶部拖拽带（ZCode project-sidebar 的 h-12 拖拽带同位）
    await userEvent.click(
      within(tree).getByRole("button", { name: "展开/收起侧边栏" }),
    );
    // 收起态：项目树与拖宽热区（separator）都不在；开关移到顶栏左端
    // （ZCode DesktopTopOverlay 同位）
    expect(screen.getByLabelText("项目树")).not.toBeVisible();
    expect(
      screen.queryByRole("separator", { name: "调整左栏宽度" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-header")).toBeInTheDocument();
    const headerToggle = screen
      .getByTestId("workspace-header")
      .querySelector("button[aria-label='展开/收起侧边栏']");
    expect(headerToggle).not.toBeNull();
    // 收起态持久化（aaw-desktop/layout/sidebar-collapsed = "1"）
    expect(
      window.localStorage.getItem("aaw-desktop/layout/sidebar-collapsed"),
    ).toBe("1");
    expect(useWorkbenchUiStore.getState().sidebarCollapsed).toBe(true);

    // 再点顶栏左端的开关展开：树回来、热区回来，持久化翻转
    await userEvent.click(headerToggle!);
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "调整左栏宽度" }),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("aaw-desktop/layout/sidebar-collapsed"),
    ).toBe("0");
  });

  it("收起态下内容区仍在（空态可见），store 状态驱动重渲染", async () => {
    render(<App />);
    await userEvent.click(
      within(screen.getByLabelText("项目树")).getByRole("button", {
        name: "展开/收起侧边栏",
      }),
    );
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });
});

describe("侧边栏会话视角", () => {
  it("切到「会话」视角：跨项目拍平按 updatedAt 降序，副行显示项目目录名并持久化", async () => {
    seedProjectWithSessions();
    seedSecondProjectWithSession();
    render(<App />);

    await switchToSessionsView();
    // 视角持久化
    expect(window.localStorage.getItem("aaw-desktop/sidebar/view")).toBe(
      "sessions",
    );

    const list = screen.getByLabelText("最近活跃会话");
    const rowTexts = within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent ?? "");
    // other-project 的会话（updatedAt 2026-10-21）排在无时间的旧会话前；
    // 同项目内 sess-1（null）在 sess-2（null）之前（稳定排序）
    expect(rowTexts).toHaveLength(3);
    expect(rowTexts[0]).toContain("会话 · 他项目任务");
    expect(rowTexts[0]).toContain(NAME_B);
    expect(rowTexts[1]).toContain("会话 · 旧任务");
    expect(rowTexts[1]).toContain(NAME);
    expect(rowTexts[2]).toContain("会话 · 更早任务");

    // 项目视角的置顶带不再出现（分组结构已随视角退出）
    expect(screen.queryByLabelText("置顶")).not.toBeInTheDocument();
  });

  it("会话视角点他项目会话：先自动连接该项目再切换（复用自动重连逻辑）", async () => {
    seedProjectWithSessions();
    seedSecondProjectWithSession();
    // 模拟真实重连：openRealWorkspace 完成后回填该项目会话列表
    vi.mocked(openRealWorkspace).mockImplementation((path) => {
      if (path === PATH_B) {
        const sessions =
          useSessionStore.getState().sessionsByPath[PATH_B] ?? [];
        useSessionStore.getState().setSessions(sessions, PATH_B);
      }
      return Promise.resolve("sess-b1");
    });
    vi.mocked(switchRealSession).mockResolvedValue(true);
    render(<App />);

    await switchToSessionsView();
    await userEvent.click(
      screen.getByRole("button", { name: /会话 · 他项目任务/ }),
    );

    await waitFor(() => {
      expect(openRealWorkspace).toHaveBeenCalledWith(PATH_B, {
        sessionId: "sess-b1",
      });
    });
    expect(switchRealSession).toHaveBeenCalledWith("sess-b1", PATH_B);
    expect(useWorkspaceStore.getState().activePath).toBe(PATH_B);
    expect(useSessionStore.getState().activeSessionId).toBe("sess-b1");
    expect(screen.getByLabelText("会话视图")).toBeInTheDocument();
  });

  it("当前打开的会话在会话视角高亮（aria-current）", async () => {
    seedProjectWithSessions();
    useSessionStore.setState({ activeSessionId: "sess-2" });
    // 高亮门控：内容区正在显示该会话（会话视图）才亮
    useWorkbenchUiStore.setState({ treeView: "session", contextPath: PATH });
    render(<App />);

    await switchToSessionsView();
    const list = screen.getByLabelText("最近活跃会话");
    expect(
      within(list).getByRole("button", { name: /会话 · 更早任务/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      within(list).getByRole("button", { name: /会话 · 旧任务/ }),
    ).not.toHaveAttribute("aria-current", "true");
  });

  it("无会话缓存时会话视角呈空态并给出「去项目列表」出口", async () => {
    render(<App />);
    await switchToSessionsView();
    expect(screen.getByText(/暂无会话记录/)).toBeInTheDocument();
    expect(screen.queryByLabelText("最近活跃会话")).not.toBeInTheDocument();

    // 空态不是死胡同：按钮切回项目视角
    await userEvent.click(screen.getByRole("button", { name: "去项目列表" }));
    expect(useWorkbenchUiStore.getState().treeViewMode).toBe("projects");
  });
});
