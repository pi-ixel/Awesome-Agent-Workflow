import type { AcpTransport } from "../host/types.ts";
import type { AcpSessionEvent } from "../acpRuntime/events.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type {
  AgentAdapter,
  AgentConfigurationSnapshot,
  AgentExecutableConfiguration,
  AgentLaunch,
  AgentProtocolCheckOptions,
  AgentProbeSessionFactory,
  AgentProbeSnapshot,
  ConnectionTestResult,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    agents: AgentsService;
  }
}

export interface AgentsService {
  readonly configuration: ReadonlySnapshot<AgentConfigurationSnapshot>;
  readonly probeState: ReadonlySnapshot<AgentProbeSnapshot>;
  readonly selectedId: string;
  selectionKey(toolPaths: object): string;
  subscribeSelection(listener: () => void): () => void;
  subscribeLaunchConfiguration(listener: () => void): () => void;
  listBuiltins(): readonly AgentAdapter[];
  resolve(id?: string): AgentAdapter | null;
  select(id: string): void;
  addCustomAgent(name: string, commandText: string): string | null;
  updateCustomAgent(id: string, name: string, commandText: string): string | null;
  removeCustomAgent(id: string): void;
  resetPreferences(): void;
  executableConfiguration(id: string): AgentExecutableConfiguration | undefined;
  buildLaunch(
    adapter: AgentAdapter,
    toolPaths: object,
    workspacePath: string | null,
  ): AgentLaunch;
  openTransport(
    adapter: AgentAdapter,
    launch: AgentLaunch,
  ): Promise<AcpTransport | null>;
  readArchive(adapter: AgentAdapter, sessionId: string, workspacePath: string): Promise<AcpSessionEvent[]>;
  scan(): Promise<void>;
  registerProbeSessions(factory: AgentProbeSessionFactory): () => Promise<void>;
  testConnection(
    id: string,
    toolPaths: object,
    onStep?: (step: string) => void,
  ): Promise<ConnectionTestResult>;
  runProtocolCheck(id: string, options: AgentProtocolCheckOptions): Promise<void>;
  shutdown(): Promise<void>;
}
