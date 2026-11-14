/**
 * 工作流发给 Agent 的说明（节点任务、AI 编辑工作流的规则）在会话里的标记。
 *
 * 说明前面单独一行写这个标记：Agent 读到的是一行普通的标题；会话界面认出它，
 * 标记之前的文字照常显示（比如用户自己写的要求），标记之后的整段收成一行
 * 「工作流给 Agent 的说明」，点开再看全文。实时消息和会话重载后 Agent 回放的
 * 历史都带着它，所以两种情况显示一致。
 */
export const WORKFLOW_INSTRUCTION_MARK = "【工作流说明】";

/** 把说明接在（可选的）用户可见文字后面，中间放标记。 */
export function withWorkflowInstruction(instruction: string, visible = ""): string {
  const head = visible.trim();
  return `${head ? `${head}\n\n` : ""}${WORKFLOW_INSTRUCTION_MARK}\n${instruction}`;
}

/** 拆开一条消息：标记之前给人看的文字，标记之后的说明（没有标记时为 null）。 */
export function splitWorkflowInstruction(text: string): { visible: string; instruction: string | null } {
  const at = text.indexOf(WORKFLOW_INSTRUCTION_MARK);
  if (at < 0) return { visible: text, instruction: null };
  return {
    visible: text.slice(0, at).trim(),
    instruction: text.slice(at + WORKFLOW_INSTRUCTION_MARK.length).replace(/^\s*\n/, ""),
  };
}
