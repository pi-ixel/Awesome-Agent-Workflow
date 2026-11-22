/** Complete, bounded source evidence. No conversation text crosses this port. */
export interface HistoryEvidence {
  readonly version: string;
  readonly users: readonly {
    readonly digest: string;
    readonly bytes: number;
    readonly compact: boolean;
    readonly sourceId: string;
  }[];
}

import type { LogEntry } from "../../shared/logging/types.ts";
import type { LoggerFactory } from "../../shared/logging/logger.ts";

import type { SsoLoginPollWire } from "./adapters/ssoTypes.ts";
import type { AcpProxyPolicy } from "./process/transportTypes.ts";

export type {
  FileEntry,
  DirectoryResult,
  FilePreview,
  WatchPath,
  DocumentFileHost,
  GitSource,
  GitChange,
  GitSnapshot,
  GitDiff,
  GitHost,
} from "./filesystem/types.ts";

export type {
  PtyOutputWire,
  PtyExitWire,
  PtySpawnWire,
  PtySpawnOptions,
  PtyNativeHost,
} from "./process/ptyTypes.ts";

export type {
  UpdatePreferences,
  UpdateManifest,
  UpdateSnapshot,
  UpdatesHost,
} from "./adapters/updateTypes.ts";

export type {
  CliFailureKind,
  CliRunResult,
  CliRunOptions,
  ProcessRunner,
} from "./process/runnerTypes.ts";

export type {
  SsoFetchWire,
  SsoLoginPollWire,
} from "./adapters/ssoTypes.ts";

export type {
  TransportExit,
  TransportLineHandler,
  TransportStderrHandler,
  TransportExitHandler,
  AcpTransport,
  AcpTransportLaunchOptions,
  AcpProxyPolicy,
} from "./process/transportTypes.ts";

/** 一次外部命令执行的结果（exit code 与标准输出/错误）。 */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 宿主能力接口：
 * copy_dir 为「先删目标再整树复制」的覆盖语义。
 */
/** 卸载清理：删掉某工具的项目目录与用户数据。 */
export interface ToolPurgeInput {
  readonly toolId: string;
  /** 账号标识（已规整过的目录段）。 */
  readonly owner: string;
  /** 要删除的项目目录；宿主会校验每个目录确实含该工具的 manifest.json。 */
  readonly projectDirs: readonly string[];
}

export interface ToolPurgeReport {
  readonly removedDirs: readonly string[];
  /** **不该删**的目录（清单读不出来、或 id 对不上）。跳过属于正常，界面如实报数即可。 */
  readonly skippedDirs: readonly string[];
  /**
   * **该删但没删掉**的目录（被占用、权限不足）。
   *
   * 必须与 `skippedDirs` 分开：两者的处理相反。前者可以放心撤记录，后者一撤
   * 就变成"盘上留着几十 MB、卡片没了、再没有重试入口"。有这一项时界面要留住
   * 记录，让用户关掉占用它的程序再点一次。
   */
  readonly failedDirs: readonly string[];
  readonly removedData: boolean;
  /** `backups/<账号>/<id>`（只有一份上一版清单）是否删掉了。 */
  readonly removedBackup: boolean;
  /**
   * `secrets/<账号>/<id>.json`（工具存下的加密凭据）是否删掉了。
   *
   * 它不属于"工具数据"那份 JSON，却同样敏感：卸载后留在盘上，重装一个同 id
   * 的工具就能读到。卸载必须一起清。
   */
  readonly removedSecrets: boolean;
}

/** `tool_prune_versions` 的报告（与 Rust 侧 `ToolPruneReport` 一一对应）。 */
export interface ToolPruneReport {
  /** 真删掉了的目录。 */
  readonly removed: readonly string[];
  /** 被记录引用或正被窗口/进程使用，因此保留的目录。 */
  readonly kept: readonly string[];
  /** 该删但没删掉（被占用、权限不足），下次还会再试。 */
  readonly skipped: readonly string[];
}

export interface HostRuntime {
  /** 实现类别：tauri（真实宿主）| demo（内存替身）。 */
  readonly kind: "tauri" | "demo";
  /** 用户主目录；旧宿主可不提供，自动探测跳过用户级安装目录。 */
  homeDir?(): Promise<string>;
  readAgentHistoryEvidence?(agentId: string, sessionId: string, cwd: string): Promise<HistoryEvidence | null>;
  deleteAgentSession?(
    agentId: string,
    program: string,
    sessionId: string,
    cwd: string,
  ): Promise<void>;
  /** 执行外部命令并等待退出（含超时保护）。失败以非零 code / stderr 表达。 */
  runCommand(program: string, args: readonly string[]): Promise<CommandResult>;
  /** 路径是否存在（文件或目录）。 */
  pathExists(path: string): Promise<boolean>;
  /** 列出目录的直接子目录名（排序稳定，供清单展示）。 */
  listDirNames(path: string): Promise<readonly string[]>;
  /** 整树复制 src → dst；dst 已存在时先删除（install.sh 的 rm -rf + cp -R）。 */
  copyDir(src: string, dst: string): Promise<void>;
  /** 读取 UTF-8 文本文件。 */
  readTextFile(path: string): Promise<string>;
  /** 写入 UTF-8 文本文件（自动创建父目录）。 */
  writeTextFile(path: string, contents: string): Promise<void>;
  /**
   * 写入二进制文件（内容以 base64 传入，自动创建父目录）。
   *
   * 工具可以自带 `node_modules`、图片、wasm，这些不是 UTF-8 文本，走
   * `writeTextFile` 会把字节改坏。ZIP 导入解压后逐个落盘用它。
   */
  writeBinaryFile?(path: string, base64: string): Promise<void>;
  /** 读取二进制文件（base64）；超过 `limit` 字节时报错，避免把大文件读进内存。 */
  readBinaryFile?(path: string, limit?: number): Promise<string>;
  /**
   * 递归列举目录内全部文件（相对路径、`/` 分隔）。
   *
   * 与 `listWorkspaceFiles` 的区别：**不跳过** `node_modules`——导出带依赖的
   * 工具时必须把依赖一起打包。
   */
  listToolFiles?(root: string, limit?: number): Promise<readonly string[]>;
  /** Resolve a namespaced user data directory; both arguments are single safe segments. */
  userDataDir(namespace: string, directory: string): Promise<string>;
  /**
   * 当前生效的「工具开发指导」正文：用户在指导窗口改过的副本优先，没有
   * 副本返回随包默认。工具项目的 `AGENTS.md` 与技能目录的 `SKILL.md` 生成
   * 时读它——改文档后 AI 读到的规范要跟着变。浏览器预览模式没有这条通道
   * （可选能力，缺省时前端退回编译进二进制的模板）。
   */
  readGuideDoc?(): Promise<string>;
  /**
   * 卸载清理：删除工具的项目目录与 `aawStore` 数据文件。
   *
   * 传进来的目录不会被无条件删除——宿主先确认其中的 manifest.json 属于该
   * 工具，对不上就跳过并在报告里返回，避免误删用户选过的父目录。
   */
  toolPurge(input: ToolPurgeInput): Promise<ToolPurgeReport>;
  /**
   * 移动文件或目录（目标必须不存在）。工具项目改名用它——同盘原子移动，
   * 不复制、不删除、不碰工具数据。
   */
  moveToolPath(from: string, to: string): Promise<void>;
  /**
   * 删除一次安装创建的工具版本目录（`<installed>/<账号>/<id>/versions/…`）。
   *
   * 只给"安装失败，把刚写进去的东西清掉"用。宿主侧只接受这个形状的路径，
   * 别处一律拒绝——删目录是不可逆操作，宁可让它窄到只能干一件事。
   */
  dropToolStaging?(path: string): Promise<void>;
  /**
   * 回收一个工具的孤儿版本副本：`installed/<账号>/<id>/versions/` 下既没有
   * 被安装记录（`dir` / `previousDir` / `sourceDir`）引用、也没有窗口或进程
   * 正在用的目录。
   *
   * 判据在宿主：只有它同时看得到安装记录与窗口表，能回答"没有记录指向它，
   * 但用户正开着它"。`owner` 是发起操作的账号；与宿主当前账号不一致时宿主
   * 拒绝执行（换账号那一瞬间不能以新身份去扫别人的目录）。
   */
  pruneToolVersions?(toolId: string, owner?: string): Promise<ToolPruneReport>;
  /**
   * 打开（或唤起）SSO 登录窗口：首次调用创建 **隐藏** 窗口（给持久
   * cookie 的静默探测留窗口期），再次调用即唤起显示。语义见 sso_login.rs。
   */
  ssoOpenLogin(loginUrl: string, attemptId: string): Promise<void>;
  /**
   * 轮询一次登录状态：读 WebView cookie → 有则以 `Cookie` 头调网关带回
   * 响应原文（非 2xx 也原文返回）；`fetched: null` = cookie 未落地；
   * `windowClosed: true` = 用户关闭了登录窗口。响应格式由 SSO 契约定义。
   */
  ssoPollLogin(endpoint: string, attemptId: string): Promise<SsoLoginPollWire>;
  listenForSsoClose(receive: (attemptId: string) => void): Promise<() => void>;
  /** 关闭 SSO 登录窗口（取消 / 成功 / 失败的统一收尾；无窗口为空操作）。 */
  ssoCloseLogin(attemptId: string): Promise<void>;
}

export type HostCommands = Pick<HostRuntime, "runCommand" | "pathExists">;

export type HostAgentCommands = HostCommands &
  Pick<HostRuntime, "homeDir" | "userDataDir">;

export type HostArchiveFiles = Pick<HostRuntime,
  | "readTextFile" | "userDataDir" | "readAgentHistoryEvidence"
  | "deleteAgentSession"
>;

export interface AcpProcessLaunch {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly extraEnv: Readonly<Record<string, string>> | null;
  readonly proxyPolicy?: AcpProxyPolicy;
  readonly isolated: boolean;
}

export type AcpProcessEvent = "stdout" | "stderr" | "exit";

/** 宿主 ACP 进程端口，事件订阅必须先于启动。 */
export interface AcpProcessHost {
  spawn(launch: AcpProcessLaunch): Promise<number>;
  subscribe(
    event: AcpProcessEvent,
    receive: (payload: unknown) => void,
  ): Promise<() => void>;
  writeLine(handle: number, line: string): Promise<void>;
  closeInput(handle: number): Promise<void>;
  killTree(handle: number): Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
  release(handle: number): Promise<void>;
}

export interface HostOptions {
  readonly createLogger?: LoggerFactory;
  readonly acpProcess?: AcpProcessHost;
  readonly createBackend?: () => HostRuntime;
}

export interface WindowHost {
  listenForClose(onClose: () => void): Promise<() => void>;
  hide(): Promise<void>;
  forceClose(): Promise<void>;
}

export interface DesktopWindowHost extends WindowHost {
  readonly chrome?: WindowChromeHost;
  isFocused(): Promise<boolean>;
  showAndFocus(): Promise<void>;
  setCloseToTray?(enabled: boolean): Promise<void>;
  claimScheduledTasks?(): Promise<boolean>;
  listenForScheduledTasksTick?(tick: () => void): Promise<() => void>;
}

export interface WindowChromeHost {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  requestClose(): Promise<void>;
  isMaximized(): Promise<boolean>;
  listenForResize(onResize: () => void): Promise<() => void>;
}

export interface HostDialogs {
  pickDirectory(this: void, title: string): Promise<string | null>;
  /** 选择若干文件；取消或不可用时返回空数组。 */
  pickFiles(this: void, title: string): Promise<readonly string[]>;
  saveFile(this: void, options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
}

export interface HostShell {
  openExternal(this: void, url: string): Promise<void>;
}

export interface HostExitGate {
  isExiting(this: void): boolean;
  begin(): (() => void) | undefined;
}

export interface HostNotificationAction {
  readonly actionId: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface HostNotification {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  /** 点击时作为跳转信息原样传回；Windows 上编码进通知链接。 */
  readonly extra: Readonly<Record<string, string>>;
  /** 同一件事用同一标记：新通知替换旧的，处理完可按标记删除（Windows）。 */
  readonly tag?: string;
}

export interface HostNotifications {
  isAvailable(): boolean;
  /** 点击通知时回调，包括从系统通知中心点击（Windows 经 aaw:// 链接转交）。 */
  listen(receive: (action: HostNotificationAction) => void): Promise<() => Promise<void>>;
  ensurePermission(): Promise<boolean>;
  send(notification: HostNotification): Promise<void>;
  /** 删除通知中心里这个标记的通知；不支持的平台什么也不做。 */
  remove(tag: string): Promise<void>;
}

export interface HostStorage {
  readonly managed?: HostManagedStorage;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface HostManagedStorage {
  available(): boolean;
  request<T>(command:
      | "session_data_read" | "session_data_write" | "session_data_list"
      | "session_data_delete"
      |
    "session_data_remove" | "storage_titles_load" | "storage_title_write" |
    "storage_thresholds_read" | "storage_thresholds_write" |
    "storage_location_read" | "storage_location_schedule" |
    "tools_location_read" | "tools_location_schedule" | "tools_storage_open" |
    "usage_initialize" | "usage_record" | "usage_query" | "usage_storage_bytes" | "usage_model_names" |
    "usage_context_read" | "usage_context_write" | "usage_context_delete",
    args?: Record<string, unknown>): Promise<T>;
  load(): Promise<void>;
  flush(): Promise<void>;
  migrated(key: string): boolean;
  isManagedKey(key: string): boolean;
  conversationKeys(): string[];
  configurationBytes(): number | undefined;
  configurationError(): string;
  conversationError(): string;
}

export type ExitDiagnostics = (entry?: LogEntry) => Promise<void>;

export type DiagnosticsCommand =
  | "storage_update_usage"
  | "update_cache_list"
  | "update_cache_remove"
  | "diagnostics_open"
  | "diagnostics_status"
  | "diagnostics_snapshot"
  | "diagnostics_storage_list"
  | "diagnostics_storage_remove"
  | "browser_restore_list"
  | "browser_restore_remove"
  | "diagnostics_probe_request"
  | "diagnostics_probe_take"
  | "diagnostics_resources"
  | "diagnostics_append"
  | "diagnostics_acp_append"
  | "diagnostics_flush"
  | "diagnostics_query"
  | "diagnostics_raw"
  | "diagnostics_export";

export interface DiagnosticsHost {
  isNative(): boolean;
  request<T>(
    command: DiagnosticsCommand,
    args?: Record<string, unknown>,
  ): Promise<T>;
  flush(finalEntry?: LogEntry): Promise<void>;
}

export type AccountHost = Pick<
  HostRuntime,
  "ssoOpenLogin" | "ssoPollLogin" | "listenForSsoClose" | "ssoCloseLogin"
>;

import type { NativeSkillLibrary } from "./filesystem/skillLibrary.ts";
export type {
  NativeSkillLibrary,
  SkillProvider,
  SkillCatalog,
  SkillQuery,
  SkillAction,
  NativeSkill,
  SkillFileRequest,
  SkillFileResponse,
} from "./filesystem/skillLibrary.ts";
export type SkillFiles = Pick<
  HostRuntime,
  | "userDataDir" | "listDirNames" | "pathExists" | "copyDir" | "writeTextFile" | "toolPurge" | "moveToolPath"
  // 安装失败清理：只删工具库 versions/ 下的副本目录
  | "dropToolStaging"
  // 孤儿版本副本回收：判断在宿主（安装记录 + 窗口表），前端只发起
  | "pruneToolVersions"
  // 工具带依赖之后要落二进制（node_modules / 图片 / wasm）并整树导出
  | "writeBinaryFile" | "readBinaryFile" | "listToolFiles"
  // 开发指导正文：用户改过的规范要贯通到 AGENTS.md 与技能目录
  | "readGuideDoc"
> & { readonly library?: NativeSkillLibrary };

/**
 * 工作流引擎（workflow_service，ADR 024 §6 修正 1）的 IPC 面：workflow
 * 插件不直接 import @tauri-apps，Tauri 边界归 host——命令与事件按白名单
 * 放行（workflow_service_* / aaw://workflow-service*），白名单外报错。
 */
export interface WorkflowEngineHost {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

export interface CodeAgentCreditRow {
  readonly kind: "CPM" | "CPD_Peak" | "CPD_Valley";
  readonly used: number;
  readonly total: number;
  readonly resetAt: string | null;
  readonly message: string | null;
}

export type CodeAgentCreditResult =
  | {
      readonly status: "ready" | "stale";
      readonly snapshot: {
        readonly rows: readonly CodeAgentCreditRow[];
        readonly fetchedAt: number;
      };
    }
  | { readonly status: "signInRequired" | "unavailable" | "unsupported" };

export interface CodeAgentTokenRow extends Omit<CodeAgentCreditRow, "kind"> {
  readonly kind: "TPM" | "TPH" | "TPD";
}

export type CodeAgentTokenResult =
  | {
      readonly status: "ready" | "stale";
      readonly snapshot: {
        readonly models: readonly {
          readonly value: string;
          readonly label: string;
        }[];
        readonly modelId: string | null;
        readonly rows: readonly CodeAgentTokenRow[];
        readonly fetchedAt: number;
      };
    }
  | {
      readonly status: "signInRequired" | "unavailable" | "unsupported";
      readonly models?: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    };
