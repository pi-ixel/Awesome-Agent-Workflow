import type { AgentsService } from "../../agents/service.ts";
import type { ProjectService } from "../../project/service.ts";

export function activeMcpProfile(
  agents: AgentsService,
  project: ProjectService,
  agentId: string,
) {
  const { toolPaths } = project.projects.workspace.getState();
  const { isBound, agentKey, activeSessionId } =
    project.conversation.foreground.session.getState();
  const { lastSessionId, runtime } =
    project.conversation.foreground.runtime.getState();
  return isBound &&
    activeSessionId !== null &&
    activeSessionId === lastSessionId &&
    agentKey === agents.selectionKey(toolPaths, agentId)
    ? (runtime.agentProfile ?? null)
    : null;
}
