import type { CustomAgentEntry, DiscoveredAgent } from "./configuration/types.ts";

export type {
  AgentAdapter,
  AgentLaunch,
  AgentLaunchContext,
} from "./registry/adapterTypes.ts";
export type { AgentExecutableConfiguration } from "./configuration/types.ts";
export type {
  AgentProbeResult,
  AgentProbeSessionFactory,
  AgentProbeSnapshot,
} from "./probe/types.ts";

export interface AgentConfigurationSnapshot {
  readonly activeAgentId: string;
  readonly agents: readonly CustomAgentEntry[];
  readonly discoveredAgents: readonly DiscoveredAgent[];
  readonly isScanningAgents: boolean;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly stderr: string;
}

export interface AgentProtocolCheckOptions {
  readonly cwd: string;
  readonly depth: "safe" | "deep";
  readonly toolPaths: object;
}
