/**
 * AI 编辑工作流的会话（ADR 036、ADR 037）：一个普通会话，挂在当前项目的会话
 * 列表里，工作目录指向草稿，并带着编写工具（check_workflow）。
 *
 * 用户在会话里说的话直接交给 Agent；第一条消息走项目会话的标准发送入口，
 * 用户的要求照常显示，规则收成一行。编写规则在草稿的 `.guide/` 目录里，
 * 第一条消息告诉 Agent 先读它。
 */
import { pluginMessage, type MessageDisplay } from "../../../shared/messageDisplay.ts";
import type { ProjectService, SessionTarget, SessionToolProvider } from "../../project/service.ts";
import type { WorkflowDraft, WorkflowDraftEditor } from "../types.ts";
import type { McpServer } from "../../../contracts/acp/protocol.ts";

/** 编辑会话的第一条消息：用户的要求照常显示，规则收成一行。 */
export function draftPrompt(kind: "edit" | "new" | "continue", request: string): { readonly text: string; readonly display: MessageDisplay } {
  const intro = kind === "new"
    ? "你在新建一个 AAW 工作流。当前目录是工作流包的草稿，里面已有一个能运行的最小示例，可以在它的基础上改写。"
    : kind === "continue"
      ? "你在继续编辑一个 AAW 工作流。当前目录是工作流包的草稿，里面是上次改到一半的内容，先看清现状再动手。"
      : "你在修改一个 AAW 工作流。当前目录是工作流包的草稿，内容和原工作流相同。";
  const instruction = [
    intro,
    "",
    "规则：",
    "- 动手前先读 .guide/workflow-format.md，按里面的格式写；",
    "- 只改当前目录里的文件，不要改 .guide/ 和 .draft.json；",
    "- 每次改完文件都调用 check_workflow 工具检查；没通过就按它给出的文件、行号和原因修正，再检查，直到通过；",
    "- 不需要运行工作流本身；",
    "- 结果字段写上 labels，让界面能读懂；会产出文件的节点写 cleanup；对外影响撤不回的节点写 irreversible；",
    "- label、does、why、delivers、去向的 label 和 explain 是写给人看的：用户在应用里审查这个工作流打算怎么运行时，流程图和节点详情显示的就是它们，读的人不了解工作流内部（字段、表达式、节点 id、内部用语）。每个节点都写 why（为什么有这一步）和 delivers（最后交出什么），有分支的步骤每条去向都写 explain（什么情况下走这条）；",
    "- 每个 Agent 节点开场收到的是一张工单：工作流的 description、所属阶段的 description、节点的 why 和 delivers、prompt、knowledge——这些同时是给执行这一步的 Agent 的权威指引，写清整体在做什么、这一阶段在做什么；运行变量（前面各步的结果）不会附给 Agent，节点要用到哪些就在 reads 里写「名字: 读来做什么」，Agent 按名字自己取；",
    "- 改完后用几句话向用户说明这个工作流现在会怎么做（按步骤说，用用户能懂的话），以及这次改了什么、为什么；不要出现文件名、字段名和节点 id。用户会在应用里看改动前后的流程图，确认后才保存。",
  ].join("\n");
  return pluginMessage({
    source: "workflow",
    foldLabel: "工作流给 Agent 的说明",
    folded: instruction,
    visible: `用户的要求：${request.trim() || "（用户还没说，先简要说明这个工作流现在做什么，再问用户想怎么改。）"}`,
  });
}

export function createDraftEditor(deps: {
  readonly project: ProjectService;
  /** 编辑会话挂在哪个项目下（当前项目）。 */
  readonly currentProject: () => string | null;
}): WorkflowDraftEditor & {
  /** 编辑会话重新打开或重连时继续带上编写工具（登记到 project.sessions.registerSessionTools）。 */
  readonly sessionTools: SessionToolProvider;
} {
  const sessions = new Map<string, { readonly target: SessionTarget & { readonly sessionId: string }; readonly tools: readonly McpServer[] }>();
  const toolsOf = (draft: WorkflowDraft): readonly McpServer[] => (draft.mcpServer ? [draft.mcpServer as McpServer] : []);

  return {
    sessionTools: ({ sessionId }) =>
      [...sessions.values()].find((session) => session.target.sessionId === sessionId)?.tools ?? [],

    async start(draft: WorkflowDraft, title: string, firstMessage: { readonly text: string; readonly display: MessageDisplay }) {
      const workspacePath = deps.currentProject();
      if (!workspacePath) throw new Error("WORKSPACE_NOT_BOUND");
      const tools = toolsOf(draft);
      // 工作目录指向草稿：Agent 只在草稿里改文件；挂上编写工具：AI 用 check_workflow 自己检查草稿能否编译。
      const opened = await deps.project.sessions.openPluginSession({ workspacePath, cwd: draft.dir, title, tools: () => tools });
      const sessionId = opened.sessionId;
      if (!sessionId) throw new Error("ACP_SESSION_ID_MISSING");
      const target = { ...opened, sessionId };
      sessions.set(draft.draftId, { target, tools });
      // 不抢前台：用户留在功能区的草稿页看改动，需要时再从草稿页打开会话（ADR 038）。
      deps.project.conversation.send(target, firstMessage.text, undefined, { display: firstMessage.display });
    },

    async show(draftId: string) {
      const session = sessions.get(draftId);
      if (!session) return false;
      await deps.project.sessions.openSessionFromEntry(session.target.workspacePath, session.target.sessionId, session.target.agentKey);
      return true;
    },

    has: (draftId: string) => sessions.has(draftId),

    send(draftId: string, text: string) {
      const session = sessions.get(draftId);
      if (!session) return false;
      return deps.project.conversation.send(session.target, text);
    },

    end(draftId: string) {
      const session = sessions.get(draftId);
      if (!session) return Promise.resolve();
      sessions.delete(draftId);
      // 草稿结束（保存或放弃）：停下正在进行的一轮。会话本身是普通会话，留在列表里。
      deps.project.conversation.cancel(session.target);
      return Promise.resolve();
    },
  };
}
