import type { ProcessRunner } from "../../host/types.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

/** 健康检查项标识。 */
export type HealthCheckItemId = string;

/** 检查结果级别：通过 / 警告 / 失败。 */
export type HealthCheckStatus = "pass" | "warn" | "fail";

/** 单项检查结果（UI 直接渲染，不再变换）。 */
export interface HealthCheckItem {
  readonly id: HealthCheckItemId;
  readonly label: string;
  readonly status: HealthCheckStatus;
  /** 结果摘要：版本号、探测耗时等（一句中文）。 */
  readonly summary: string;
  /** 中文修复指引；status 为 pass 时为空字符串。 */
  readonly fixHint: string;
  /** 该项探测耗时（毫秒）。 */
  readonly durationMs: number;
}

export interface WorkspaceHealthCheckOptions {
  readonly workspacePath: string;
  readonly toolPaths: WorkspaceToolPaths;
  readonly runner: ProcessRunner;
  readonly signal?: AbortSignal;
}

export type WorkspaceHealthCheck = (
  options: WorkspaceHealthCheckOptions,
) => Promise<readonly HealthCheckItem[]>;

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

/** 针对所选目录的健康检查报告。 */
export interface HealthReport {
  readonly path: string;
  readonly items: readonly HealthCheckItem[];
  readonly checkedAt: string;
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
  /** 当前选中（未打开）的工作区目录。 */
  readonly selectedPath: string | null;
  /** 已打开的工作区：ACP session 的 cwd 绑定点。 */
  readonly activePath: string | null;
  readonly health: HealthReport | null;
  readonly isCheckingHealth: boolean;
  readonly healthCheckAvailable: boolean;
  /** 外部工具路径（设置页的「工具路径」落点；持久化）。 */
  readonly toolPaths: WorkspaceToolPaths;
  /** 最近一次连接失败（按项目匹配展示；成功连接或用户关闭即清除）。 */
  readonly lastConnectError: ConnectError | null;
}

export interface WorkspaceStoreState extends WorkspaceSnapshot {
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
  removeFromRecent: (path: string) => void;
  setToolPaths: (paths: WorkspaceToolPaths) => void;
  /** 连接失败回填入口（realRuntime 调用；UI 据此渲染错误横幅与徽标）。 */
  reportConnectFailure: (path: string, message: string) => void;
  /** 清除某项目的连接失败态（连接成功 / 用户关闭横幅时调用）。 */
  dismissConnectError: (path: string) => void;
  /** 健康检查服务回填入口。 */
  applyHealthReport: (path: string, items: readonly HealthCheckItem[]) => void;
  /**
   * 异步执行健康检查，默认使用当前 Host 的进程服务。
   * pathsOverride 供组件层把「设置里的路径」（chrys 可执行路径、由
   * skills 源目录推导的 aaw 脚本路径）合入本次执行，不落盘。
   */
  runHealthChecks: (
    runner?: ProcessRunner,
    pathsOverride?: Partial<WorkspaceToolPaths>,
  ) => Promise<void>;
  /** 从 localStorage 恢复持久化字段（测试与初始化用）。 */
  hydrateFromStorage: () => void;
}

export const emptyWorkspace: WorkspaceSnapshot = {
  recentWorkspaces: [],
  pinnedPaths: [],
  pinnedSessions: [],
  selectedPath: null,
  activePath: null,
  health: null,
  isCheckingHealth: false,
  healthCheckAvailable: false,
  toolPaths: defaultToolPaths,
  lastConnectError: null,
};

export type WorkspaceView = ReadonlySnapshot<WorkspaceSnapshot>;
