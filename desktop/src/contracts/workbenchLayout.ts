import type { GitChange, ReviewSource } from "./git.ts";

export const SESSION_LIST_PAGE_SIZE = 5;

/** 树选中驱动的基底视图。 */
export type ContentView = "project-overview" | "session";

/** 设置页覆盖当前项目视图。 */
export type OverlayView = "settings";

/** 侧边栏视角：项目树 / 跨项目最近会话。 */
export type TreeViewMode = "projects" | "sessions";

export interface WorkbenchUiState {
  /** 基底视图（功能页覆盖层之外的当前视图）。 */
  readonly treeView: ContentView;
  /** 树选中项目路径（总览 / 会话共用的项目上下文）；null 未选。 */
  readonly contextPath: string | null;
  /** 功能页覆盖（全屏语义）；null 表示显示基底视图。 */
  readonly overlay: OverlayView | null;
  readonly settingsInitialTab: string;
  readonly openSettingsTab: (tab: string) => void;
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
  /** 会话顶部 AAW 流程时间线的收起态（布局偏好，持久化）。 */
  readonly isTimelineCollapsed: boolean;
  /**
   * 底部终端面板（execute 工具输出的只读回放）是否展开。默认关闭且
   * **不持久化**，对齐 ZCode useAppPanels 的缺省（终端面板开合是会话内
   * 临时状态，重启回到关闭）。
   */
  readonly isTerminalOpen: boolean;
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

export type PanelTool = "aaw" | "files" | "git";

export type PanelTab =
  | { id: string; kind: "file"; path: string; line?: number; openedAt?: number }
  | { id: string; kind: "directory"; path: string; openedAt?: number }
  | {
      id: string;
      kind: "diff";
      path: string;
      repoRoot: string;
      change: GitChange;
      openedAt?: number;
    }
  | { id: "aaw"; kind: "aaw"; openedAt?: number }
  | { id: "files"; kind: "files"; openedAt?: number }
  | { id: "git"; kind: "git"; openedAt?: number }
  | { id: "new-tab"; kind: "new-tab"; openedAt?: number };

/** 完整视图状态（ZCode side-pane-full-view/contract.ts:4-5/22-29 同形）。 */
export type PanelFullView = {
  surface: "conversation" | "side-pane";
  floating: "collapsed" | "expanded" | "minimized";
  anchor:
    | "top-left"
    | "top-right"
    | "left-center"
    | "right-center"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
};

export interface ProjectPanel {
  open: boolean;
  width: number;
  gitWidth?: number;
  /** 页面控制只保存比例；旧像素尺寸仅用于兼容旧数据。 */
  sizeRatio?: number;
  active: string;
  tabs: readonly PanelTab[];
  gitSource?: ReviewSource;
  gitReveal?: { source: ReviewSource; revision: number };
  toolViews?: Partial<Record<PanelTool, string>>;
  /** 最近关闭的 tab（新→旧，cap 10；会话级状态不落盘）。 */
  recentlyClosed?: { tab: PanelTab; closedAt: number }[];
  /** 完整视图状态（会话级状态不落盘）。 */
  fullView?: PanelFullView;
}

export interface RightPanelState {
  projects: Record<string, ProjectPanel>;
  tool: (project: string, tool: PanelTool) => void;
  /** 仅重开右栏（ContextBar 分栏开关），active/tabs 原样保留。 */
  open: (project: string) => void;
  collapse: (project: string) => void;
  width: (project: string, width: number) => void;
  resize: (project: string, ratio: number) => void;
  activate: (project: string, id: string) => void;
  openNewTab: (project: string) => void;
  openFile: (project: string, path: string, line?: number) => void;
  openDirectory: (project: string, path: string) => void;
  openDiff: (project: string, repoRoot: string, change: GitChange) => void;
  closeTab: (project: string, id: string) => void;
  closeOthers: (project: string, id: string) => void;
  closeAll: (project: string) => void;
  /** 拖动排序落位：把 id 移到 toIndex（越界夹取，激活态不变）。 */
  moveTab: (project: string, id: string, toIndex: number) => void;
  reopenClosed: (project: string, id: string) => void;
  fullViewOpen: (project: string, surface: PanelFullView["surface"]) => void;
  fullViewPatch: (project: string, partial: Partial<PanelFullView>) => void;
  fullViewExit: (project: string) => void;
  gitSource: (project: string, source: ReviewSource) => void;
  setToolView: (project: string, tool: PanelTool, view: string) => void;
}
