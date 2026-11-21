import type { BrowserHost } from "./browser/types.ts";
import type { McpManagementHost } from "../../contracts/mcp/management.ts";
import type {
  AcpProcessHost,
  AcpTransport,
  AcpTransportLaunchOptions,
  AccountHost,
  CodeAgentCreditResult,
  CodeAgentTokenResult,
  DesktopWindowHost,
  DiagnosticsHost,
  DocumentFileHost,
  ExitDiagnostics,
  GitHost,
  HostAgentCommands,
  HostArchiveFiles,
  HostDialogs,
  HostExitGate,
  HostNotifications,
  HostShell,
  HostStorage,
  ProcessRunner,
  PtyNativeHost,
  SkillFiles,
  UpdatesHost,
  WorkflowEngineHost,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    host: HostService;
  }
}

export interface HostService {
  readonly mcp?: McpManagementHost;
  isNative(): boolean;
  readonly acpProcess: AcpProcessHost;
  readonly browser: BrowserHost;
  openDevelopmentAcpTransport(
    options: AcpTransportLaunchOptions,
  ): Promise<AcpTransport | null>;
  readonly storage: HostStorage;
  readonly diagnostics: DiagnosticsHost;
  registerExitDiagnostics(flush: ExitDiagnostics): () => void;
  readonly commands: HostAgentCommands;
  readonly window: DesktopWindowHost;
  readonly dialogs: HostDialogs;
  readonly shell: HostShell;
  readonly exitGate: HostExitGate;
  readonly notifications: HostNotifications;
  readonly archives: HostArchiveFiles;
  readonly files: DocumentFileHost;
  readonly git: GitHost;
  readonly terminal: PtyNativeHost;
  readonly process: ProcessRunner;
  readonly skills: SkillFiles;
  readonly account: AccountHost;
  readCodeAgentCredit(): Promise<CodeAgentCreditResult>;
  readCodeAgentTokenQuota(modelId?: string): Promise<CodeAgentTokenResult>;
  readonly updates: UpdatesHost;
  readonly workflowEngine: WorkflowEngineHost;
  /** 打开一个工具窗口。不给 `toolId` 时打开启动器（工具列表）。 */
  openTool(this: void, toolId?: string): Promise<void>;
  /** 彻底停止一个常驻后台的工具（关窗只是隐藏，这条才是真退出）。 */
  stopTool(this: void, toolId: string): Promise<void>;
  /** 打开「工具开发指导」窗口（内容与 AI 读的规范同源）。 */
  openToolsGuide(this: void): Promise<void>;
  writeToolArchive(this: void, path: string, bytes: Uint8Array): Promise<void>;
  listenLauncher(this: void, open: (target: string) => void | Promise<void>): Promise<() => void>;
}
export { AcpWriteError } from "./process/transportErrors.ts";
export { openWindowRequests } from "./storage/windowRequests.ts";
export { desktopManagedStorage, flushNativeConfiguration, loadNativeConfiguration, nativeConfigurationStatus,
  nativeConversationTextStatus, webviewStorage } from "./storage/storage.ts";
