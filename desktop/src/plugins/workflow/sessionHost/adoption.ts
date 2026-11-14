import type { AcpSessionPort, AcpProtocolResources } from "../../acpRuntime/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { HostStorage } from "../../host/types.ts";
import type { ProjectService } from "../../project/service.ts";
import type { NativeHostDeps } from "./nativeSessionHost.ts";
import { configurationDigest, readRunOwner, readSessionOwner, writeRunOwner, writeSessionOwner } from "./sessionOwner.ts";
import { readRunExecutors } from "../status/executors.ts";

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
    const paths = project.projects.workspace.getState().toolPaths;
    const commandOf = (id: string) => {
      const candidate = agents.resolve(id);
      return candidate ? JSON.stringify(agents.buildLaunch(candidate, paths, options.workspacePath).command) : null;
    };
    const wanted = JSON.stringify(options.command);
    // ADR 036：这个角色在这次运行里另指定了 Agent。记录还没写下时（启动应答前就来了节点），按命令认出 Agent。
    const roleAgent = options.role ? readRunExecutors(storage, options.runId)[options.role]?.agentId : undefined;
    const matches = (id: string | undefined): id is string => typeof id === "string" && commandOf(id) === wanted;
    const byCommand = () => [runOwner?.agentId, agents.selectedId].find(matches) ?? agentIds(agents).find(matches);
    const agentId = owner?.agentId ?? roleAgent ?? (runOwner && commandOf(runOwner.agentId) === wanted ? runOwner.agentId : byCommand()) ?? runOwner?.agentId ?? agents.selectedId;
    const adapter = agents.resolve(agentId);
    if (!adapter) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
    const launch = agents.buildLaunch(adapter, paths, options.workspacePath);
    if (JSON.stringify(launch.command) !== wanted) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
    const currentDigest = () => configurationDigest(agents.selectionKey(project.projects.workspace.getState().toolPaths, agentId));
    const identity = await currentDigest();
    if (owner && owner.configuration !== identity) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
    // 运行的默认 Agent：只有用默认 Agent 的节点核对并记下它；按角色另指定的 Agent 由会话归属记录。
    // 还没有运行的默认记录时，启动时选中的 Agent 才是默认的（其余是按角色另指定的）。
    const isDefault = runOwner ? runOwner.agentId === agentId : agentId === agents.selectedId;
    if (isDefault && runOwner && runOwner.configuration !== identity) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
    if (isDefault && !roleAgent) writeRunOwner(storage, options.runId, { agentId, configuration: identity });
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

/** 全部可用的 Agent：内置、本机扫描到的与自定义的。 */
function agentIds(agents: AgentsService): string[] {
  const state = agents.configuration.getState();
  return [...agents.listBuiltins().map((item) => item.id), ...state.discoveredAgents.map((item) => item.id), ...state.agents.map((item) => item.id)];
}

