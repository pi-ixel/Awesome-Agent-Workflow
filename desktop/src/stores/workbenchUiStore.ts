/**
 * 工作台界面状态 store：内容区视图、左栏树的展开态、AAW 增强面板的开合
 * 与侧边栏布局偏好（纯 UI 状态，不持业务数据——项目与会话数据仍在各自
 * 的 store）。
 *
 * 视图模型（树状视图 + 内容区布局）：
 * - 基底视图 treeView 由左栏树的选中项驱动（项目总览 / 会话），
 *   contextPath 是选中项所属的项目路径（两个视图共用的项目上下文）；
 * - 会话是骨架，AAW 是挂在会话上的增强：入口向导不是独立的一层视图，
 *   而是会话内可开合的 AAW 面板（isAawOpen）里的一个分段——新建会话
 *   默认就是一条空对话，用户想从 SR / AR / dev 入口启动时才打开它；
 * - 「设置 / 诊断」是功能页覆盖层 overlay，自侧栏底部 SidebarFooter 的
 *   入口激活后呈**全屏**语义：侧边栏树列与顶栏按钮组隐藏，内容区只
 *   渲染该页 + 上下文条「← 返回」；再点同页入口（或返回按钮）取消
 *   覆盖，点树节点同样清除；
 * - 树的展开态只记「用户显式切换」的覆盖值：未出现的项目按默认规则
 *   （有会话子节点的展开）渲染，规则本身由组件计算，store 不复刻数据源；
 * - 侧边栏收起态 sidebarCollapsed 表示「隐藏 / 显示树列」（收起后开关
 *   移入顶栏左端 / 树列顶部拖拽带，无第二条窄条）与树的视角
 *   treeViewMode 是布局偏好，变更即持久化到 localStorage（键见下方常量），
 *   模块加载时恢复；【+】弹出面板、AAW 面板与底部终端面板是纯会话内
 *   状态，不持久化（终端默认关闭，对齐 ZCode useAppPanels 的缺省）。
 */
import { create } from "zustand";

import { createLogger } from "../core/logger.ts";
import { pathKey } from "../core/panelPaths.ts";

/** 树选中驱动的基底视图。 */
export type ContentView = "project-overview" | "session";

/** 功能页覆盖层（全屏语义）。 */
/** 诊断已并入设置页「诊断」页签，覆盖层只剩设置一个全屏功能页。 */
export type OverlayView = "settings";

/** 侧边栏视角：项目树 / 跨项目最近会话。 */
export type TreeViewMode = "projects" | "sessions";

/** 侧边栏收起态的持久化键。 */
const SIDEBAR_COLLAPSED_KEY = "aaw-desktop/layout/sidebar-collapsed";
/** 侧边栏视角的持久化键。 */
const TREE_VIEW_MODE_KEY = "aaw-desktop/sidebar/view";

/** 流程时间线收起态的持久化键。 */
const TIMELINE_COLLAPSED_KEY = "aaw-desktop/layout/timeline-collapsed";

/** 读持久化字符串（缺失 / 环境不支持返回 null）。 */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写持久化字符串（失败不阻断——布局偏好丢得起）。 */
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响本次会话内的布局
  }
}

/** 从持久化恢复收起态（"1" 为收起；缺失 / 损坏按展开处理）。 */
function restoreSidebarCollapsed(): boolean {
  return readPref(SIDEBAR_COLLAPSED_KEY) === "1";
}

/** 从持久化恢复视角（仅接受 "sessions"；其余按项目视角处理）。 */
function restoreTreeViewMode(): TreeViewMode {
  return readPref(TREE_VIEW_MODE_KEY) === "sessions" ? "sessions" : "projects";
}

/** 从持久化恢复时间线收起态（"1" 为收起；缺失按展开处理）。 */
function restoreTimelineCollapsed(): boolean {
  // 默认收起（紧凑进度条是常态，全图抽屉按需展开）；显式展开过（"0"）
  // 的老偏好保持展开
  return readPref(TIMELINE_COLLAPSED_KEY) !== "0";
}

interface WorkbenchUiState {
  /** 基底视图（功能页覆盖层之外的当前视图）。 */
  readonly treeView: ContentView;
  /** 树选中项目路径（总览 / 会话共用的项目上下文）；null 未选。 */
  readonly contextPath: string | null;
  /** 功能页覆盖（全屏语义）；null 表示显示基底视图。 */
  readonly overlay: OverlayView | null;
  /** 用户显式切换过展开态的项目路径 → 是否展开（缺省按组件默认规则）。 */
  readonly expandedOverrides: Readonly<Record<string, boolean>>;
  /**
   * 项目路径 → 会话子节点已呈现条数（缺省 SESSION_LIST_PAGE_SIZE）。
   * 「加载更多」按页递增；纯展示态不持久化，重启回到默认页。
   */
  readonly sessionListLimits: Readonly<Record<string, number>>;
  /** 侧边栏（树列）是否收起为隐藏（持久化；常驻图标窄栏不受影响）。 */
  readonly sidebarCollapsed: boolean;
  /** 侧边栏视角：项目树 / 最近会话（持久化）。 */
  readonly treeViewMode: TreeViewMode;
  /** 【+】弹出面板（新建会话 / 添加项目）是否展开（不持久化）。 */
  readonly isAddPanelOpen: boolean;
  /**
   * 会话内的 AAW 增强面板（工作流进度 + 从入口启动向导）是否展开。
   * 默认收起：会话以对话为主，AAW 信息按需拉出来看（不持久化）。
   */
  readonly isAawOpen: boolean;
  /**
   * 待定位的向导入口（/sr /ar /dev 命令选中后写入）：AAW 面板据此把
   * EntryWizard 直接开到对应入口的变量表单；null = 默认从入口选择起。
   */
  readonly aawWizardEntry: "sr" | "ar" | "dev" | null;
  /** 一次绑定项目的斜杠入口请求；处理后保留标识，避免重挂向导丢草稿。 */
  readonly aawWizardRequest: {
    readonly id: number;
    readonly project: string;
    readonly entry: "sr" | "ar" | "dev";
    readonly handled: boolean;
  } | null;
  /** 会话顶部 AAW 流程时间线的收起态（布局偏好，持久化）。 */
  readonly isTimelineCollapsed: boolean;
  /**
   * 底部终端面板（execute 工具输出的只读回放）是否展开。默认关闭且
   * **不持久化**，对齐 ZCode useAppPanels 的缺省（终端面板开合是会话内
   * 临时状态，重启回到关闭）。
   */
  readonly isTerminalOpen: boolean;
  /** 关闭守卫确认弹窗（Rust CloseRequested 转交，一律弹出）。 */
  readonly isCloseGuardOpen: boolean;
  /**
   * 弹出瞬间的忙闲快照（决定弹窗文案变体：忙=中断警示，闲=退出提示）。
   * 快照在弹出时冻结：弹窗开着期间运行状态再变化也不翻转内容，避免
   * 用户注视下按钮含义中途改变。仅 isCloseGuardOpen 时有意义。
   */
  readonly closeGuardBusy: boolean;
  /**
   * 退出收口中（确认关闭 → force_close 之间）：根级「正在退出」遮罩盖住
   * 正常 UI——窗口隐藏是主路径，遮罩是它失效时的兜底（无权限/其他运行
   * 时），保证确认后用户看到的不是「还能用」的界面；此态下关闭请求
   * 不再重复弹窗。
   */
  readonly isExiting: boolean;

  /** 关闭守卫确认弹窗（由 App 的 close-requested 监听按需打开并冻结快照）。 */
  readonly openCloseGuard: (busy: boolean) => void;
  /** 关闭守卫确认弹窗（取消/ dismissing 后关闭；快照留待下次弹出覆盖）。 */
  readonly setCloseGuardOpen: (open: boolean) => void;
  /** 进入退出收口态（一次性；进程随之销毁，无需退出该态的方法）。 */
  readonly markExiting: () => void;
  /** 选中项目节点：内容区切到该项目总览（并清除覆盖层与弹出面板）。 */
  readonly openProjectOverview: (path: string) => void;
  /** 选中会话子节点：内容区切到会话视图（项目上下文切到所属项目）。 */
  readonly openSessionView: (path: string) => void;
  /**
   * 打开失败回滚：把内容区恢复到点击前的视图（乐观打开落在死会话上时，
   * 树选中态随视图一并还原，不留「点过但没去成」的假高亮）。
   */
  readonly restoreContextView: (view: {
    readonly treeView: ContentView;
    readonly contextPath: string | null;
  }) => void;
  /** 开 / 关会话内的 AAW 增强面板。 */
  readonly toggleAaw: () => void;
  /** 打开 AAW 面板并把向导定位到指定入口（slash 命令 /sr /ar /dev 用）。 */
  readonly openAawWizard: (entry: "sr" | "ar" | "dev") => void;
  readonly finishAawWizardRequest: (id: number) => void;
  readonly toggleTimeline: () => void;
  /** 开 / 关底部终端面板（顶栏终端钮与面板关闭钮共用，不持久化）。 */
  readonly toggleTerminal: () => void;
  /** 功能页开关：再点同一页取消覆盖（回到树选中视图）。 */
  readonly toggleOverlay: (view: OverlayView) => void;
  /** 关闭功能页覆盖层（全屏页的「← 返回」入口）。 */
  readonly closeOverlay: () => void;
  /**
   * 切换某项目节点的展开 / 折叠。`isExpandedNow` 是**当前实际渲染出的
   * 状态**——默认展开规则（有会话才展开）由组件计算，store 不复刻数据源；
   * 组件把真相传进来，store 记下它的反面即可。传 null 表示调用方确实不
   * 知道当前态（旧语义：按「默认展开」取反）。
   */
  readonly toggleExpanded: (
    path: string,
    isExpandedNow?: boolean | null,
  ) => void;
  /** 项目被移出列表时：内容区正停留在该项目则回落到未选中的空态。 */
  readonly clearContextIf: (path: string) => void;
  /** 收起 / 展开侧边栏树列（持久化；窄栏开关共用该动作）。 */
  readonly toggleSidebarCollapsed: () => void;
  /** 切换侧边栏视角（持久化）。 */
  readonly setTreeViewMode: (mode: TreeViewMode) => void;
  /** 开 / 关【+】弹出面板。 */
  readonly toggleAddPanel: () => void;
  /** 关闭【+】弹出面板（点外部 / Esc / 完成动作后的收口）。 */
  readonly closeAddPanel: () => void;
  /** 「加载更多」：该项目的会话子节点再纳入一页（SESSION_LIST_PAGE_SIZE 条）。 */
  readonly expandSessionList: (path: string) => void;
}

const logger = createLogger("ui");

/** 会话子节点每项目的默认呈现条数，也是「加载更多」的步长。 */
export const SESSION_LIST_PAGE_SIZE = 5;

let aawWizardRequestId = 0;

export const useWorkbenchUiStore = create<WorkbenchUiState>((set, get) => ({
  treeView: "project-overview",
  contextPath: null,
  overlay: null,
  expandedOverrides: {},
  sessionListLimits: {},
  sidebarCollapsed: restoreSidebarCollapsed(),
  treeViewMode: restoreTreeViewMode(),
  isTimelineCollapsed: restoreTimelineCollapsed(),
  isTerminalOpen: false,
  isAddPanelOpen: false,
  isAawOpen: false,
  aawWizardEntry: null,
  aawWizardRequest: null,
  isCloseGuardOpen: false,
  closeGuardBusy: false,
  isExiting: false,

  openCloseGuard: (busy) => {
    set({ isCloseGuardOpen: true, closeGuardBusy: busy });
  },

  setCloseGuardOpen: (open) => {
    set({ isCloseGuardOpen: open });
  },

  markExiting: () => {
    set({ isExiting: true });
  },

  openProjectOverview: (path) => {
    const request = get().aawWizardRequest;
    set({
      treeView: "project-overview",
      contextPath: path,
      overlay: null,
      isAddPanelOpen: false,
      isAawOpen: false,
      aawWizardEntry: null,
      aawWizardRequest:
        request && pathKey(request.project) === pathKey(path) ? request : null,
    });
    logger.debug("内容区切换到项目总览", { path });
  },

  openSessionView: (path) => {
    const request = get().aawWizardRequest;
    set({
      treeView: "session",
      contextPath: path,
      overlay: null,
      isAddPanelOpen: false,
      isAawOpen: false,
      aawWizardEntry: null,
      aawWizardRequest:
        request && pathKey(request.project) === pathKey(path) ? request : null,
    });
    logger.debug("内容区切换到会话视图", { path });
  },

  restoreContextView: (view) => {
    const request = get().aawWizardRequest;
    set({
      treeView: view.treeView,
      contextPath: view.contextPath,
      aawWizardRequest:
        request &&
        view.contextPath &&
        pathKey(request.project) === pathKey(view.contextPath)
          ? request
          : null,
    });
    logger.debug("内容区回滚到点击前的视图", view);
  },

  openAawWizard: (entry) => {
    const project = get().contextPath;
    set({
      isAawOpen: true,
      aawWizardEntry: entry,
      aawWizardRequest: project
        ? { id: ++aawWizardRequestId, project, entry, handled: false }
        : null,
    });
    logger.debug("AAW 面板已开并定位向导入口", { entry });
  },

  finishAawWizardRequest: (id) => {
    const request = get().aawWizardRequest;
    if (request?.id === id && !request.handled)
      set({ aawWizardRequest: { ...request, handled: true } });
  },

  toggleAaw: () => {
    const next = !get().isAawOpen;
    set({ isAawOpen: next });
    logger.debug("AAW 增强面板切换", { open: next });
  },

  toggleTimeline: () => {
    const next = !get().isTimelineCollapsed;
    set({ isTimelineCollapsed: next });
    writePref(TIMELINE_COLLAPSED_KEY, next ? "1" : "0");
  },

  toggleTerminal: () => {
    const next = !get().isTerminalOpen;
    set({ isTerminalOpen: next });
    logger.debug("底部终端面板切换", { open: next });
  },

  toggleOverlay: (view) => {
    const next = get().overlay === view ? null : view;
    set({ overlay: next });
    logger.debug("功能页覆盖层切换", { view, open: next !== null });
  },

  closeOverlay: () => {
    if (get().overlay === null) {
      return;
    }
    set({ overlay: null });
    logger.debug("功能页覆盖层已关闭（返回树选中视图）");
  },

  toggleExpanded: (path, isExpandedNow = null) => {
    set((state) => {
      const current = state.expandedOverrides[path] ?? null;
      // 组件把「现在是不是展开的」传进来时，覆盖值即它的反面（精确）；
      // 未传时退回旧语义——以「默认展开（有会话）」的反面为目标。
      const next =
        isExpandedNow === null
          ? current === null
            ? false
            : !current
          : !isExpandedNow;
      return {
        expandedOverrides: { ...state.expandedOverrides, [path]: next },
      };
    });
  },

  clearContextIf: (path) => {
    if (get().contextPath !== path) {
      return;
    }
    set({
      treeView: "project-overview",
      contextPath: null,
      isAawOpen: false,
      aawWizardRequest: null,
    });
    logger.debug("项目已移出列表，内容区回落空态", { path });
  },

  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    writePref(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    logger.debug("侧边栏收起态切换", { collapsed: next });
  },

  setTreeViewMode: (mode) => {
    set({ treeViewMode: mode });
    writePref(TREE_VIEW_MODE_KEY, mode);
    logger.debug("侧边栏视角切换", { mode });
  },

  toggleAddPanel: () => {
    const next = !get().isAddPanelOpen;
    set({ isAddPanelOpen: next });
    logger.debug("【+】弹出面板切换", { open: next });
  },

  closeAddPanel: () => {
    if (!get().isAddPanelOpen) {
      return;
    }
    set({ isAddPanelOpen: false });
  },

  expandSessionList: (path) => {
    const { sessionListLimits } = get();
    const current = sessionListLimits[path] ?? SESSION_LIST_PAGE_SIZE;
    set({
      sessionListLimits: {
        ...sessionListLimits,
        [path]: current + SESSION_LIST_PAGE_SIZE,
      },
    });
  },
}));
