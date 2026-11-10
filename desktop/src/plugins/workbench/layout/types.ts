export interface PageActivation {
  /** Null uses the default page registered by the application. */
  readonly viewId: string | null;
  readonly contextPath: string | null;
}

/** 设置页覆盖当前项目视图。 */
export type OverlayView = "settings";

export interface WorkbenchUiState extends PageActivation {
  /** 功能页覆盖（全屏语义）；null 表示显示基底视图。 */
  readonly overlay: OverlayView | null;
  readonly settingsInitialTab: string;
  readonly openSettingsTab: (tab: string, isCurrent?: () => boolean) => void;
  /** 侧边栏（树列）是否收起为隐藏（持久化；常驻图标窄栏不受影响）。 */
  readonly sidebarCollapsed: boolean;
  /** 当前打开的底部面板。默认关闭，开合状态不落盘。 */
  readonly openDock: string | null;
  readonly openView: (id: string, path: string | null, isCurrent?: () => boolean) => void;
  readonly restoreContextView: (view: PageActivation) => void;
  readonly toggleDock: (id: string) => void;
  readonly closeDock: (id: string) => void;
  /** 功能页开关：再点同一页取消覆盖（回到树选中视图）。 */
  readonly toggleOverlay: (view: OverlayView) => void;
  /** 关闭功能页覆盖层（全屏页的「← 返回」入口）。 */
  readonly closeOverlay: () => void;
  /** Clear the matching context and return to the registered default page. */
  readonly clearContextIf: (path: string, isCurrent?: () => boolean) => void;
  /** 收起 / 展开侧边栏树列（持久化；窄栏开关共用该动作）。 */
  readonly toggleSidebarCollapsed: () => void;
}

export interface PanelTab {
  readonly id: string;
  readonly kind: string;
  readonly openedAt?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

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
  readonly open: boolean;
  /** 右栏占用内容区的比例。 */
  readonly sizeRatio?: number;
  readonly active: string;
  readonly tabs: readonly PanelTab[];
  readonly toolViews?: Readonly<Record<string, string | undefined>>;
  /** 最近关闭的 tab（新→旧，cap 10；会话级状态不落盘）。 */
  readonly recentlyClosed?: readonly { readonly tab: PanelTab; readonly closedAt: number }[];
  /** 完整视图状态（会话级状态不落盘）。 */
  readonly fullView?: PanelFullView;
}

export interface RightPanelState {
  readonly projects: Readonly<Record<string, ProjectPanel>>;
  readonly tool: (project: string, id: string) => void;
  /** 仅重开右栏（ContextBar 分栏开关），active/tabs 原样保留。 */
  readonly open: (project: string) => void;
  readonly collapse: (project: string) => void;
  readonly resize: (project: string, ratio: number) => void;
  readonly activate: (project: string, id: string, isCurrent?: () => boolean) => void;
  readonly openNewTab: (project: string) => void;
  readonly openTab: (project: string, tab: PanelTab, isCurrent?: () => boolean) => void;
  readonly closeTab: (project: string, id: string) => void;
  readonly closeOthers: (project: string, id: string) => void;
  readonly closeAll: (project: string) => void;
  /** 拖动排序落位：把 id 移到 toIndex（越界夹取，激活态不变）。 */
  readonly moveTab: (project: string, id: string, toIndex: number) => void;
  readonly reopenClosed: (project: string, id: string) => void;
  readonly fullViewOpen: (project: string, surface: PanelFullView["surface"]) => void;
  readonly fullViewPatch: (project: string, partial: Partial<PanelFullView>) => void;
  readonly fullViewExit: (project: string) => void;
  readonly setToolView: (project: string, id: string, view: string) => void;
}
