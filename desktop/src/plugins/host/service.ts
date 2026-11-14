import type {
  AcpProcessHost,
  AcpTransport,
  AcpTransportLaunchOptions,
  AccountHost,
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
  isNative(): boolean;
  readonly acpProcess: AcpProcessHost;
  openDevelopmentAcpTransport(options: AcpTransportLaunchOptions): Promise<AcpTransport | null>;
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
  readonly updates: UpdatesHost;
  readonly workflowEngine: WorkflowEngineHost;
}
export { AcpWriteError } from "./process/transportErrors.ts";
export { openWindowRequests } from "./storage/windowRequests.ts";
export { desktopManagedStorage, flushNativeConfiguration, loadNativeConfiguration, nativeConfigurationStatus,
  nativeConversationTextStatus, webviewStorage } from "./storage/storage.ts";
