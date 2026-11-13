/**
 * AI 编辑工作流的会话（ADR 036）：工作目录指向草稿，收养进当前项目的会话列表。
 *
 * 会话是普通对话：用户在会话里说的话经 onUserMessage 直接交给 Agent；
 * 第一条消息走项目会话的标准发送入口，和用户自己打的字一样显示。
 * 编写规则在草稿的 `.guide/` 目录里，第一条消息告诉 Agent 先读它。
 */
import type { AcpProtocolResources, AcpSessionPort } from "../../acpRuntime/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { ProjectService } from "../../project/service.ts";
import type { WorkflowDraft, WorkflowDraftEditor } from "../types.ts";
import type { McpServer } from "../../../contracts/acp/protocol.ts";

const CLIENT_INFO = { name: "aaw-desktop-workflow-editor", version: "0.1.0" };

/** 编辑会话的第一条消息。 */
export function draftPrompt(kind: "edit" | "new" | "continue", request: string): string {
  const intro = kind === "new"
    ? "你在新建一个 AAW 工作流。当前目录是工作流包的草稿，里面已有一个能运行的最小示例，可以在它的基础上改写。"
    : kind === "continue"
      ? "你在继续编辑一个 AAW 工作流。当前目录是工作流包的草稿，里面是上次改到一半的内容，先看清现状再动手。"
      : "你在修改一个 AAW 工作流。当前目录是工作流包的草稿，内容和原工作流相同。";
  return [
    intro,
    "",
    "规则：",
    "- 动手前先读 .guide/workflow-format.md，按里面的格式写；",
    "- 只改当前目录里的文件，不要改 .guide/ 和 .draft.json；",
    "- 每次改完文件都调用 check_workflow 工具检查；没通过就按它给出的文件、行号和原因修正，再检查，直到通过；",
    "- 不需要运行工作流本身；",
    "- 结果字段写上 labels，让界面能读懂；会产出文件的节点写 cleanup；对外影响撤不回的节点写 irreversible；",
    "- 改完后用几句话说明改了什么、为什么，用户会在应用里看改动前后的流程图和源码差异，确认后才保存。",
    "",
    `用户的要求：${request.trim() || "（用户还没说，先简要说明这个工作流现在做什么，再问用户想怎么改。）"}`,
  ].join("\n");
}

export function createDraftEditor(deps: {
  readonly project: ProjectService;
  readonly agents: AgentsService;
  readonly protocol: AcpProtocolResources;
  /** 编辑会话挂在哪个项目下（当前项目）。 */
  readonly currentProject: () => string | null;
}): WorkflowDraftEditor {
  const sessions = new Map<string, { workspacePath: string; sessionId: string; agentKey: string; port: AcpSessionPort }>();

  return {
    async start(draft: WorkflowDraft, title: string, firstMessage: string) {
      const workspacePath = deps.currentProject();
      if (!workspacePath) throw new Error("WORKSPACE_NOT_BOUND");
      const adapter = deps.agents.resolve();
      if (!adapter) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
      if (!deps.protocol.openIndependent) throw new Error("WORKFLOW_AGENT_CONNECTION_UNAVAILABLE");
      const paths = deps.project.projects.workspace.getState().toolPaths;
      const agentKey = deps.agents.selectionKey(paths, adapter.id);
      let port: AcpSessionPort | null = null;
      const adopted = await deps.project.sessions.adoptExternalSession({
        workspacePath,
        agentId: adapter.id,
        title,
        onUserMessage: async (_sessionId, text) => {
          if (!port) throw new Error("ACP_SESSION_REQUIRED");
          await port.prompt(text);
        },
        create: async (sessionOptions) => {
          const opened = await deps.protocol.openIndependent!(adapter, agentKey, paths, {
            ...sessionOptions,
            clientInfo: CLIENT_INFO,
          } as Parameters<AcpProtocolResources["open"]>[1]);
          try {
            await opened.initialize();
            // 工作目录指向草稿：Agent 只在草稿里改文件。
            // 挂上编写工具：AI 用 check_workflow 自己检查草稿能否编译。
            await opened.newSession(draft.dir, { mcpServers: draft.mcpServer ? [draft.mcpServer as McpServer] : [] });
            if (!opened.sessionId) throw new Error("ACP_SESSION_ID_MISSING");
          } catch (error) {
            await deps.protocol.release(opened);
            throw error;
          }
          port = opened;
          return opened;
        },
      });
      if (!adopted || !port) throw new Error("ACP_SESSION_ADOPTION_REJECTED");
      sessions.set(draft.draftId, { workspacePath, sessionId: adopted.sessionId, agentKey, port });
      await deps.project.sessions.openSessionFromEntry(workspacePath, adopted.sessionId, agentKey);
      deps.project.conversation.send({ workspacePath, agentKey, sessionId: adopted.sessionId }, firstMessage);
    },

    async show(draftId: string) {
      const session = sessions.get(draftId);
      if (!session) return false;
      await deps.project.sessions.openSessionFromEntry(session.workspacePath, session.sessionId, session.agentKey);
      return true;
    },

    has: (draftId: string) => sessions.has(draftId),

    send(draftId: string, text: string) {
      const session = sessions.get(draftId);
      if (!session) return false;
      return deps.project.conversation.send({ workspacePath: session.workspacePath, agentKey: session.agentKey, sessionId: session.sessionId }, text);
    },

    async end(draftId: string) {
      const session = sessions.get(draftId);
      if (!session) return;
      sessions.delete(draftId);
      session.port.cancel();
      await deps.protocol.release(session.port).catch(() => undefined);
    },
  };
}
