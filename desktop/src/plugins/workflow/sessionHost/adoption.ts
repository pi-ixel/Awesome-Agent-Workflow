import type { AcpSessionPort, AcpProtocolResources } from "../../acpRuntime/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { HostStorage } from "../../host/types.ts";
import type { ProjectService } from "../../project/service.ts";
import type { NativeHostDeps } from "./nativeSessionHost.ts";
import { configurationDigest, readRunOwner, readSessionOwner, writeRunOwner, writeSessionOwner } from "./sessionOwner.ts";

/** 每个会话的 Agent 归属在交给引擎前保存；恢复时只接受原身份与配置。 */
export function createWorkflowAdoption(
  project: ProjectService,
  agents: AgentsService,
  storage: HostStorage,
  protocol: AcpProtocolResources,
): NativeHostDeps["adoptSession"] {
  return async (options) => {
    const owner = options.resumeSessionId === null ? null : readSessionOwner(storage, options.workspacePath, options.resumeSessionId);
    if (options.resumeSessionId !== null && owner === null) throw new Error("WORKFLOW_SESSION_OWNER_MISSING");
    const runOwner = readRunOwner(storage, options.runId);
    const agentId = owner?.agentId ?? runOwner?.agentId ?? agents.selectedId;
    const adapter = agents.resolve(agentId);
    if (!adapter) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
    const paths = project.projects.workspace.getState().toolPaths;
    const launch = agents.buildLaunch(adapter, paths, options.workspacePath);
    if (JSON.stringify(launch.command) !== JSON.stringify(options.command)) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
    const currentDigest = () => configurationDigest(agents.selectionKey(project.projects.workspace.getState().toolPaths, agentId));
    const identity = await currentDigest();
    if ((owner && owner.configuration !== identity) || (runOwner && (runOwner.agentId !== agentId || runOwner.configuration !== identity))) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
    writeRunOwner(storage, options.runId, { agentId, configuration: identity });
    for (let attempt = 0; attempt < 5; attempt++) {
      const adopted = await project.sessions.adoptExternalSession({
        workspacePath: options.workspacePath,
        agentId,
        title: options.title,
        onUserMessage: options.onUserMessage,
        create: async (sessionOptions, context) => {
          const session = await options.create(
            sessionOptions as Parameters<typeof options.create>[0],
            { ...context, agentId },
          ) as unknown as AcpSessionPort;
          try {
            if (!session.sessionId) throw new Error("ACP_SESSION_ID_MISSING");
            if (identity !== await currentDigest()) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
            if (!owner) writeSessionOwner(storage, options.workspacePath, session.sessionId, { agentId, configuration: identity });
            return session;
          } catch (error) {
            await protocol.release(session);
            throw error;
          }
        },
      });
      if (adopted !== null) return adopted;
      // null 在收养入口任何创建动作之前返回（例如 Agent 正在切换）。
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("ACP_SESSION_ADOPTION_REJECTED");
  };
}
