import type { AcpSessionPort, AcpProtocolResources } from "../../acpRuntime/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { HostStorage } from "../../host/types.ts";
import type { ProjectService } from "../../project/service.ts";
import type { NativeHostDeps } from "./nativeSessionHost.ts";
import { configurationDigest, readSessionOwner, writeSessionOwner } from "./sessionOwner.ts";

/**
 * 单 Agent 原则：节点会话一律用当前选中的 Agent，与普通会话同池同身份。
 * 每个会话的归属在交给引擎前保存；恢复时只接受同一身份——归属记录缺失、
 * Agent 不同或配置变更都丢弃恢复意图、开全新会话（已完成节点的产出记录在
 * 运行日志里，流程照常续走），绝不跨身份续跑。
 */
export function createWorkflowAdoption(
  project: ProjectService,
  agents: AgentsService,
  storage: HostStorage,
  protocol: AcpProtocolResources,
): NativeHostDeps["adoptSession"] {
  return async (options) => {
    const adapter = agents.resolve();
    if (!adapter) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
    const identity = async () =>
      configurationDigest(agents.selectionKey(project.projects.workspace.getState().toolPaths, adapter.id));
    const currentDigest = await identity();
    // 恢复意图只在身份完全一致时保留；否则本轮按全新会话走。
    let resumeSessionId = options.resumeSessionId;
    if (resumeSessionId !== null) {
      const owner = readSessionOwner(storage, options.workspacePath, resumeSessionId);
      if (owner === null || owner.agentId !== adapter.id || owner.configuration !== currentDigest) {
        resumeSessionId = null;
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const adopted = await project.sessions.adoptExternalSession({
        workspacePath: options.workspacePath,
        title: options.title,
        onUserMessage: options.onUserMessage,
        create: async (sessionOptions, context) => {
          const session = await options.create(
            sessionOptions as unknown as Parameters<typeof options.create>[0],
            { ...context, agentId: adapter.id, resumeSessionId },
          ) as unknown as AcpSessionPort;
          try {
            if (!session.sessionId) throw new Error("ACP_SESSION_ID_MISSING");
            // 途中换了配置（或换了 Agent）：如实失败，不悄悄错配身份。
            if (currentDigest !== await identity()) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
            if (resumeSessionId === null) {
              writeSessionOwner(storage, options.workspacePath, session.sessionId, { agentId: adapter.id, configuration: currentDigest });
            }
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
