import type { AgentAdapter, AgentLaunch } from "./agentAdapter.ts";
import type { AcpTransport } from "./acpTransport.ts";
import type { AcpSessionEvent } from "./acpSession.ts";
import type { AgentProbeResult, AgentProbeSessionFactory, AgentProbeSnapshot } from "./agentProbe.ts";
import type { AgentConfigurationState, AgentExecutableConfiguration } from "./agentConfiguration.ts";
import type { StoreApi } from "zustand";

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly stderr: string;
}

export interface AgentsService {
  readonly configuration: Pick<
    StoreApi<AgentConfigurationState>,
    "getState" | "getInitialState" | "subscribe"
  >;
  readonly probeState: Pick<
    StoreApi<AgentProbeSnapshot>,
    "getState" | "getInitialState" | "subscribe"
  >;
  readonly selectedId: string;
  selectionKey(toolPaths: object): string;
  subscribeSelection(listener: () => void): () => void;
  listBuiltins(): readonly AgentAdapter[];
  resolve(id?: string): AgentAdapter | null;
  select(id: string): void;
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
  probe(
    id: string,
    options: {
      readonly cwd: string;
      readonly depth: "safe" | "deep";
      readonly toolPaths: object;
      readonly onStep?: (step: string) => void;
    },
  ): Promise<AgentProbeResult>;
  runProtocolCheck(
    id: string,
    options: {
      readonly cwd: string;
      readonly depth: "safe" | "deep";
      readonly toolPaths: object;
    },
  ): Promise<void>;
  shutdown(): Promise<void>;
}
