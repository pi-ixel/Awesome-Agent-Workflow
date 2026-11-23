import type { BrowserHost } from "./browser/types.ts";
import type { TurnChangesHost } from "../../contracts/turnChanges/types.ts";
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
  OpsSidecarHost,
  ProcessRunner,
  PtyNativeHost,
  RemoteDocumentFileProvider,
  RemoteGitProvider,
  RemoteTerminalResolver,
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
  readonly turnChanges?: TurnChangesHost;
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
  registerRemoteDocumentFiles(provider: RemoteDocumentFileProvider): () => void;
  readonly git: GitHost;
  registerRemoteGit(provider: RemoteGitProvider): () => void;
  readonly terminal: PtyNativeHost;
  registerRemoteTerminalResolver(resolver: RemoteTerminalResolver): () => void;
  readonly process: ProcessRunner;
  readonly skills: SkillFiles;
  readonly account: AccountHost;
  readCodeAgentCredit(): Promise<CodeAgentCreditResult>;
  readCodeAgentTokenQuota(modelId?: string): Promise<CodeAgentTokenResult>;
  readonly updates: UpdatesHost;
  readonly workflowEngine: WorkflowEngineHost;
  readonly opsSidecar: OpsSidecarHost;
}
export { AcpWriteError } from "./process/transportErrors.ts";
export { openWindowRequests } from "./storage/windowRequests.ts";
export { desktopManagedStorage, flushNativeConfiguration, loadNativeConfiguration, nativeConfigurationStatus,
  nativeConversationTextStatus, webviewStorage } from "./storage/storage.ts";
