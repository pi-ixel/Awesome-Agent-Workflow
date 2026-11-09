import type { AgentAdapter } from "../../contracts/agentAdapter.ts";
import { resolveAgentAdapter } from "./registry.ts";
import type { AgentConfigurationState } from "../../contracts/agentConfiguration.ts";

type AgentSelection = Pick<
  AgentConfigurationState,
  "agents" | "discoveredAgents" | "activeAgentId"
>;

export function resolveConfiguredAgent(
  state: AgentSelection,
  id = state.activeAgentId,
): AgentAdapter | null {
  return (
    resolveAgentAdapter(id, state.agents, state.discoveredAgents)?.adapter ??
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
): string {
  const adapter = resolveConfiguredAgent(state);
  return JSON.stringify([
    state.activeAgentId,
    adapter ? buildAgentLaunch(adapter, state, toolPaths, null) : undefined,
  ]);
}
