import type { AgentAdapter } from "./adapterTypes.ts";
import { agentAdapters, resolveAgentAdapter } from "./registry.ts";
import type { AgentConfigurationState } from "../configuration/types.ts";

type AgentSelection = Pick<
  AgentConfigurationState,
  "agents" | "discoveredAgents" | "activeAgentId"
>;

export function resolveConfiguredAgent(
  state: AgentSelection,
  id = state.activeAgentId,
  adapters = agentAdapters,
): AgentAdapter | null {
  return (
    resolveAgentAdapter(id, state.agents, state.discoveredAgents, adapters)?.adapter ??
    null
  );
}

export function buildAgentLaunch(
  adapter: AgentAdapter,
  settings: object,
  toolPaths: object,
  workspacePath: string | null,
) {
  return adapter.buildLaunch({
    workspacePath,
    executablePath: adapter.configuredExecutable?.(settings, toolPaths),
  });
}

/** 草稿与目录的身份投影可以在 ACP 服务启动前计算。 */
export function agentSelectionKey(
  state: AgentSelection,
  toolPaths: object,
  adapters = agentAdapters,
  agentId = state.activeAgentId,
): string {
  const adapter = resolveConfiguredAgent(state, agentId, adapters);
  return JSON.stringify([
    agentId,
    adapter ? buildAgentLaunch(adapter, state, toolPaths, null) : undefined,
  ]);
}
