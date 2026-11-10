import type { LogEntry } from "../../shared/logging/types.ts";
import type { LoggerFactory } from "../../shared/logging/logger.ts";

import type { SsoLoginPollWire } from "./adapters/ssoTypes.ts";

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
export interface HostRuntime {
  /** 实现类别：tauri（真实宿主）| demo（内存替身）。 */
  readonly kind: "tauri" | "demo";
  /** 用户主目录；旧宿主可不提供，自动探测跳过用户级安装目录。 */
  homeDir?(): Promise<string>;
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
  /** Resolve a namespaced user data directory; both arguments are single safe segments. */
  userDataDir(namespace: string, directory: string): Promise<string>;
  /**
   * 打开（或唤起）SSO 登录窗口：首次调用创建 **隐藏** 窗口（给持久
   * cookie 的静默探测留窗口期），再次调用即唤起显示。语义见 sso_login.rs。
   */
  ssoOpenLogin(loginUrl: string): Promise<void>;
  /**
   * 轮询一次登录状态：读 WebView cookie → 有则以 `Cookie` 头调网关带回
   * 响应原文（非 2xx 也原文返回）；`fetched: null` = cookie 未落地；
   * `windowClosed: true` = 用户关闭了登录窗口。响应格式由 SSO 契约定义。
   */
  ssoPollLogin(endpoint: string): Promise<SsoLoginPollWire>;
  /** 关闭 SSO 登录窗口（取消 / 成功 / 失败的统一收尾；无窗口为空操作）。 */
  ssoCloseLogin(): Promise<void>;
}

export type HostCommands = Pick<HostRuntime, "runCommand" | "pathExists">;

export type HostAgentCommands = HostCommands &
  Pick<HostRuntime, "homeDir" | "userDataDir">;

export type HostArchiveFiles = Pick<HostRuntime, "readTextFile" | "userDataDir">;

export interface AcpProcessLaunch {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly extraEnv: Readonly<Record<string, string>> | null;
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
  readonly extra: Readonly<Record<string, string>>;
}

export interface HostNotifications {
  isAvailable(): boolean;
  listen(receive: (action: HostNotificationAction) => void): Promise<() => Promise<void>>;
  ensurePermission(): Promise<boolean>;
  send(notification: HostNotification): Promise<void>;
}

export interface HostStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type ExitDiagnostics = (entry?: LogEntry) => Promise<void>;

export type DiagnosticsCommand =
  | "diagnostics_open"
  | "diagnostics_status"
  | "diagnostics_snapshot"
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
  "ssoOpenLogin" | "ssoPollLogin" | "ssoCloseLogin"
>;

export type SkillFiles = Pick<
  HostRuntime,
  "userDataDir" | "listDirNames" | "pathExists" | "copyDir" | "writeTextFile"
>;
