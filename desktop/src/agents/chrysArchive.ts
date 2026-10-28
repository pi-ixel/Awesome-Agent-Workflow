/** Chrys 压缩归档只读适配：不把模型摘要当作用户消息，不修改 agent 状态。 */
import type { AcpSessionEvent } from "../acp/session.ts";
import { joinPath, type HostRuntime } from "../core/host.ts";
import { normalizeSessionPath } from "./chrysSessions.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function identity(message: RecordValue): string {
  const properties = record(message.additional_properties);
  return (
    string(properties._chrys_analytics_item_id) ||
    string(properties._chrys_message_id)
  );
}

/** 同一归档/消息按持久化身份去重；相同文字的不同提问必须保留。 */
export function parseChrysArchive(
  raw: unknown,
  sessionId: string,
  cwd: string,
): AcpSessionEvent[] {
  const root = record(raw),
    meta = record(root.meta),
    state = record(root.state);
  if (
    meta.session_id !== sessionId ||
    normalizeSessionPath(string(meta.primary_cwd)) !== normalizeSessionPath(cwd)
  ) {
    throw new Error("归档会话或项目不匹配");
  }
  if (state.compressed_msgs === undefined) return [];
  if (!Array.isArray(state.compressed_msgs))
    throw new Error("压缩归档格式不受支持");
  const seen = new Set<string>();
  // 普通历史交给 ACP；归档中仍与有效上下文重叠的消息不重复回放。
  for (const value of list(state.messages)) {
    const message = record(value),
      props = record(message.additional_properties);
    const id = identity(message);
    if (id && !props._excluded) seen.add(id);
  }
  const blocks = state.compressed_msgs.map(record).sort((a, b) => {
    const start = (block: RecordValue): number => {
      const turn = list(block.turn_range)[0];
      return typeof turn === "number" ? turn : 0;
    };
    return start(a) - start(b);
  });
  const seenBlocks = new Set<string>();
  const events: AcpSessionEvent[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const blockId =
      string(block.compressed_context_id) || `block-${blockIndex}`;
    if (seenBlocks.has(blockId)) continue;
    seenBlocks.add(blockId);
    if (!Array.isArray(block.messages)) throw new Error("压缩归档缺少消息原文");
    for (const [messageIndex, value] of block.messages.entries()) {
      const message = record(value),
        props = record(message.additional_properties);
      if (
        "_chrys_kind" in props ||
        props._continuation ||
        !["user", "assistant", "tool"].includes(string(message.role))
      )
        continue;
      const persistedId = identity(message);
      if (persistedId && seen.has(persistedId)) continue;
      if (persistedId) seen.add(persistedId);
      const messageId = `archive:${sessionId}:${persistedId || `${blockId}:${messageIndex}`}`;
      // 归档里的 _excluded 是压缩结果，不能据此再次丢弃原文。
      for (const value of list(message.contents)) {
        const content = record(value),
          text = typeof value === "string" ? value : string(content.text);
        if (
          (content.type === "text" || typeof value === "string") &&
          text &&
          message.role !== "tool"
        ) {
          events.push({
            type:
              message.role === "user"
                ? "user_message_chunk"
                : "agent_message_chunk",
            sessionId,
            messageId,
            text,
          });
        } else if (content.type === "text_reasoning" && text) {
          events.push({
            type: "agent_thought_chunk",
            sessionId,
            messageId,
            text,
          });
        } else if (content.type === "function_call") {
          events.push({
            type: "tool_call",
            sessionId,
            toolCallId: `archive:${blockId}:${string(content.call_id)}`,
            title: string(content.name),
            // 归档中没有结果的调用不应在恢复后永久显示“运行中”。
            status: "failed",
            rawOutput: "归档中未找到工具结果",
            rawInput: content.arguments,
          });
        } else if (content.type === "function_result") {
          events.push({
            type: "tool_call_update",
            sessionId,
            toolCallId: `archive:${blockId}:${string(content.call_id)}`,
            status: string(content.exception) ? "failed" : "completed",
            rawOutput: content.result ?? content.items,
          });
        }
      }
    }
  }
  return events;
}

export async function readChrysArchive(
  host: HostRuntime,
  sessionId: string,
  cwd: string,
): Promise<AcpSessionEvent[]> {
  // 只接受 UUID/十六进制会话标识，绝不让会话名成为任意磁盘路径。
  if (!/^[a-f0-9-]{12,36}$/i.test(sessionId))
    throw new Error("会话标识不受支持");
  const root = await host.chrysSessionsDir();
  const shortId = sessionId.replaceAll("-", "").slice(0, 12);
  const text = await host.readTextFile(joinPath(root, shortId, "session.json"));
  if (text.length > 32 * 1024 * 1024) throw new Error("会话归档超过读取上限");
  return parseChrysArchive(JSON.parse(text) as unknown, sessionId, cwd);
}
