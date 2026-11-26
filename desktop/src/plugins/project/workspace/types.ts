import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

/** 工具路径：各插件按自己的键存取（Agent 可执行文件归各自的适配器配置）。 */
export interface WorkspaceToolPaths {
  readonly [key: string]: string | undefined;
}

/** 缺省工具路径。 */
export const defaultToolPaths: WorkspaceToolPaths = {};

/** 一个最近打开的工作区。 */
export interface WorkspaceEntry {
  readonly path: string;
  /** 最近一次打开时间（ISO 8601）。 */
  readonly lastOpenedAt: string;
}

/** 以主目录为项目身份，关联目录不独立注册到项目树。 */
export interface ProjectFolders {
  readonly name: string;
  readonly relatedPaths: readonly string[];
}

/** 一次「打开项目」连接失败的用户可见错误（含修复指引）。 */
export interface ConnectError {
  readonly path: string;
  readonly message: string;
}

export interface WorkspaceSnapshot {
  readonly recentWorkspaces: readonly WorkspaceEntry[];
  readonly pinnedPaths: readonly string[];
  /** 会话级置顶集合（sessionPinKey 键；持久化，序 = 置顶先后，最新在前）。 */
  readonly pinnedSessions: readonly string[];
  readonly starredSessions: readonly string[];
  /** 当前选中（未打开）的工作区目录。 */
  readonly selectedPath: string | null;
  /** 已打开的工作区：ACP session 的 cwd 绑定点。 */
  readonly activePath: string | null;
  /** 外部工具路径（设置页的「工具路径」落点；持久化）。 */
  readonly toolPaths: WorkspaceToolPaths;
  /** 最近一次连接失败（按项目匹配展示；成功连接或用户关闭即清除）。 */
  readonly lastConnectError: ConnectError | null;
  readonly projectFolders?: Readonly<Record<string, ProjectFolders>>;
}

export interface WorkspaceStoreState extends WorkspaceSnapshot {
  registerProject: (path: string, folders?: ProjectFolders) => void;
  updateProjectFolders: (path: string, folders: ProjectFolders) => void;
  selectWorkspace: (path: string) => void;
  clearSelection: () => void;
  openWorkspace: (path?: string) => void;
  closeWorkspace: () => void;
  togglePinned: (path: string) => void;
  /** 会话级置顶开关（ZCode task.pinned 语义；会话菜单 pin/unpin 用）。 */
  toggleSessionPinned: (
    path: string,
    sessionId: string,
    agentKey?: string,
  ) => void;
  toggleSessionStarred: (path: string, sessionId: string, agentKey?: string) => void;
  removeFromRecent: (path: string) => void;
  setToolPaths: (paths: WorkspaceToolPaths) => void;
  /** 连接失败回填入口（realRuntime 调用；UI 据此渲染错误横幅与徽标）。 */
  reportConnectFailure: (path: string, message: string) => void;
  /** 清除某项目的连接失败态（连接成功 / 用户关闭横幅时调用）。 */
  dismissConnectError: (path: string) => void;
  /** 从 localStorage 恢复持久化字段（测试与初始化用）。 */
  hydrateFromStorage: () => void;
}

export const emptyWorkspace: WorkspaceSnapshot = {
  recentWorkspaces: [],
  pinnedPaths: [],
  pinnedSessions: [],
  starredSessions: [],
  selectedPath: null,
  activePath: null,
  toolPaths: defaultToolPaths,
  lastConnectError: null,
};

export type WorkspaceView = ReadonlySnapshot<WorkspaceSnapshot>;
