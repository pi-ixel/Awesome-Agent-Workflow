import type { HistoryEvidence } from "../host/types.ts";
import type { AcpTransport } from "../host/types.ts";
import { findAgentAdapter } from "./registry/registry.ts";

/** Reporting identity is owned by the registered Agent enhancement. */
export function normalizeUsageModelId(agent: string | undefined, model: string | null): string | null {
  if (!agent || model === null) return model;
  return findAgentAdapter(agent)?.usageModelId?.(model) ?? model;
}
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
    agentSwitchGuard: AgentSwitchGuard;
  }
}

/** 切换 Agent 前要先停下的一项工作（如一次进行中的工作流运行）。 */
export interface AgentSwitchWork {
  readonly id: string;
  readonly title: string;
}

/**
 * 切换闸（ADR 037）：会用到当前 Agent 连接的插件登记它，切换前先停下进行中
 * 的工作，否则切换会掐断它们的会话。由可选服务 `agentSwitchGuard` 提供；
 * 未装配时没有闸。
 */
export interface AgentSwitchGuard {
  /** 现在进行中的工作（跨项目）。 */
  readonly activeWork: () => Promise<readonly AgentSwitchWork[]>;
  /** 确认弹窗里的说明（如「有 2 个工作流正在运行（…），切换会先停止它们」）。 */
  readonly describe: (work: readonly AgentSwitchWork[]) => string;
  /** 停下这些工作（确认切换后、执行切换前调用）。 */
  readonly stopAll: (work: readonly AgentSwitchWork[]) => Promise<void>;
}

export interface AgentsService {
  readonly configuration: ReadonlySnapshot<AgentConfigurationSnapshot>;
  readonly probeState: ReadonlySnapshot<AgentProbeSnapshot>;
  readonly selectedId: string;
  selectionKey(toolPaths: object, agentId?: string): string;
  subscribeSelection(listener: () => void): () => void;
  subscribeLaunchConfiguration(listener: () => void): () => void;
  listBuiltins(): readonly AgentAdapter[];
  resolve(id?: string): AgentAdapter | null;
  select(id: string): void;
  addCustomAgent(name: string, commandText: string, supportsCustomAnswers?: boolean): string | null;
  updateCustomAgent(id: string, name: string, commandText: string, supportsCustomAnswers?: boolean): string | null;
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
  readHistoryEvidence?(adapter: AgentAdapter, sessionId: string, cwd: string): Promise<HistoryEvidence | null>;
  readArchive(adapter: AgentAdapter, sessionId: string, workspacePath: string): Promise<AcpSessionEvent[]>;
  canDeleteSession?(agentKey: string): boolean;
  deleteSession?(
    agentKey: string,
    workspacePath: string,
    sessionId: string,
  ): Promise<void>;
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
