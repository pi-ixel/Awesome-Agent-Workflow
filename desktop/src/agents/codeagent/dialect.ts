import { childToolKind } from "../../core/subagentTool.ts";
import { parseToolLocations } from "../../acp/toolLocations.ts";
import type { AcpDialect, AcpSessionEvent } from "../../acp/session.ts";
import { asRecord, asString } from "../../acp/parse.ts";
import { parseChunkText } from "../../acp/session.ts";
import type { PlanEntry } from "../../acp/types.ts";
import type {
  SubagentMessage,
  SubagentToolPresentation,
  SubagentToolRecord,
} from "../../core/subagentTool.ts";

type ToolEvent = Extract<
  AcpSessionEvent,
  { type: "tool_call" | "tool_call_update" }
>;
interface Task {
  id: string;
  parent?: string;
  agentType?: string;
  events: {
    at: number;
    update: Readonly<Record<string, unknown>>;
    signature: string;
  }[];
  truncated: boolean;
}
const key = (session: string, id: string) => JSON.stringify([session, id]);
const spawner = /^(agent|task|spawn_agent|spawnagent)$/i;
function object(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}
/** Empty live input is a known CodeAgent behavior. Keep fallback separate from raw evidence. */
function hasInput(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  );
}
function inputPresentation(input: unknown, title: unknown) {
  return {
    inputFallback: hasInput(input)
      ? null
      : typeof title === "string"
        ? title
        : "",
  };
}
export function toolNameOf(
  tool: Readonly<Record<string, unknown>>,
): string | null {
  return asString(asRecord(asRecord(tool._meta)?.codeAgentCLI)?.toolName);
}
/** Recognized vendor config IDs only; unknown options keep standard handling. */
export function normalizeConfigOptions(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return (raw as unknown[]).map((value) => {
    const option = asRecord(value);
    if (!option || (option.id !== "model" && option.id !== "mode"))
      return value;
    return {
      ...option,
      category: option.category ?? option.id,
      name: option.name ?? (option.id === "model" ? "模型" : "模式"),
    };
  });
}
export function normalizePermission(
  tool: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const name = toolNameOf(tool);
  return name ? { ...tool, toolName: name } : tool;
}

/** All state is per connection. Task and tool identities are further session-scoped. */
export function createCodeAgentDialect(): AcpDialect {
  const parents = new Map<string, ToolEvent>();
  const tasks = new Map<string, Task>();
  const owners = new Map<string, string>();
  let bufferedCharacters = 0;
  const planSignatures = new Map<string, string>();
  const planSignature = (entries: readonly PlanEntry[]) =>
    JSON.stringify(
      entries.map(({ content, status, priority }) => [
        content,
        status,
        priority,
      ]),
    );
  const remember = <T>(map: Map<string, T>, id: string, value: T) => {
    map.set(id, value);
    if (map.size > 1024) map.delete(map.keys().next().value!);
  };
  function presentation(parent: ToolEvent): SubagentToolPresentation {
    const input = object(parent.rawInput),
      output = object(parent.rawOutput);
    const related = [...tasks.values()].filter(
      (task) => task.parent === key(parent.sessionId, parent.toolCallId),
    );
    const messages: SubagentMessage[] = [];
    const tools: SubagentToolRecord[] = [];
    for (const task of related) {
      const taskTools = new Map<string, SubagentToolRecord>();
      let openMessage: { key: string; index: number } | undefined;
      for (const { update } of task.events) {
        const variant = update.sessionUpdate;
        if (
          variant === "agent_message_chunk" ||
          variant === "agent_thought_chunk"
        ) {
          const originalText = parseChunkText(update.content);
          if (originalText.length > 65536) task.truncated = true;
          const text = originalText.slice(0, 65536);
          if (!text) continue;
          const kind =
            variant === "agent_thought_chunk" ? "thought" : "message";
          const id = `${task.id}:${asString(update.messageId) ?? kind}`;
          const previous = openMessage
            ? messages[openMessage.index]
            : undefined;
          if (openMessage?.key === id && previous) {
            if (previous.text.length + text.length > 131072)
              task.truncated = true;
            messages[openMessage.index] = {
              ...previous,
              text: (previous.text + text).slice(-131072),
            };
          } else {
            openMessage = { key: id, index: messages.length };
            messages.push({ id: `${id}:${messages.length}`, kind, text });
          }
        } else if (variant === "tool_call" || variant === "tool_call_update") {
          openMessage = undefined;
          const id = asString(update.toolCallId);
          if (!id) continue;
          const previous = taskTools.get(id);
          const terminal = previous?.state === "returned";
          const returned =
            terminal ||
            update.status === "completed" ||
            update.status === "failed";
          taskTools.set(id, {
            ...previous,
            id: `${task.id}:${id}`,
            name:
              toolNameOf(update) ??
              previous?.name ??
              asString(update.title) ??
              id,
            state: returned ? "returned" : "running",
            ...(typeof update.title === "string"
              ? { title: update.title }
              : {}),
            ...(childToolKind(update.kind)
              ? { kind: childToolKind(update.kind) }
              : {}),
            ...("content" in update ? { content: update.content } : {}),
            ...(Array.isArray(update.locations)
              ? { locations: parseToolLocations(update.locations) }
              : {}),
            ...(update.status === "completed"
              ? { failed: false }
              : update.status === "failed" || previous?.failed
                ? { failed: true }
                : {}),
            ...(hasInput(previous?.input) && !hasInput(update.rawInput)
              ? { input: previous!.input }
              : "rawInput" in update
                ? { input: update.rawInput }
                : {}),
            ...inputPresentation(
              hasInput(update.rawInput) ? update.rawInput : previous?.input,
              update.title ?? previous?.inputFallback,
            ),
            ...("rawOutput" in update
              ? { output: update.rawOutput }
              : "content" in update
                ? { output: update.content }
                : {}),
          });
        }
      }
      tools.push(...taskTools.values());
    }
    const finalText =
      parseChunkText(output?.content ?? parent.rawOutput) ||
      parseChunkText(parent.content);
    if (
      finalText &&
      messages
        .filter((message) => message.kind === "message")
        .map((message) => message.text)
        .join("")
        .trim() !== finalText.trim()
    )
      messages.push({
        id: "history-result",
        kind: "message",
        text: finalText.slice(0, 131072),
      });
    return {
      name:
        related.find((task) => task.agentType)?.agentType ??
        asString(output?.agentType) ??
        asString(input?.subagent_type) ??
        parent.title ??
        "子代理",
      task:
        asString(input?.description)?.trim() ||
        asString(input?.prompt)?.trim() ||
        (parent.title?.trim() &&
        !spawner.test(parent.title.trim()) &&
        parent.title !== parent.toolCallId
          ? parent.title.trim()
          : ""),
      stats: null,
      progress: {
        id: parent.toolCallId,
        toolCalls: tools.filter((tool) => tool.state === "returned").length,
      },
      ...(parent.status === "failed"
        ? { phase: "aborted" as const }
        : related.some((task) => task.events.length > 0) &&
            parent.status !== "completed"
          ? { phase: "running" as const }
          : {}),
      messages: messages.slice(-200),
      tools: tools.slice(-200),
      ...(related.some((task) => task.truncated) ||
      messages.length > 200 ||
      tools.length > 200 ||
      finalText.length > 131072
        ? { detail: "早期进度已超出展示缓存，完整报文请查诊断日志" }
        : {}),
    };
  }
  function absorbedTools(parent: ToolEvent): string[] {
    const ids = new Set<string>();
    for (const [taskKey, task] of tasks) {
      if (task.parent !== key(parent.sessionId, parent.toolCallId)) continue;
      const children = new Set(
        task.events.flatMap(({ update }) => {
          const id = asString(update.toolCallId);
          return id &&
            id !== parent.toolCallId &&
            (update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update")
            ? [id]
            : [];
        }),
      );
      for (const id of children) {
        const identity = key(parent.sessionId, id);
        if (!owners.has(identity)) {
          // History can establish the parent after both live streams have arrived.
          const cached = parents.get(identity);
          if (cached) {
            const update = { ...cached, sessionUpdate: cached.type };
            const signature = JSON.stringify(update);
            task.events.push({ at: Date.now(), update, signature });
            bufferedCharacters += signature.length;
            while (
              task.events.length > 500 ||
              (bufferedCharacters > 4 * 1024 * 1024 && task.events.length > 0)
            ) {
              bufferedCharacters -= task.events.shift()!.signature.length;
              task.truncated = true;
            }
          }
        }
        remember(owners, identity, taskKey);
        ids.add(id);
      }
    }
    return [...ids];
  }
  function childNotification(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): AcpSessionEvent | null {
    if (method !== "_subagent/update") return null;
    const session = asString(params.sessionId),
      id = asString(params.taskId),
      update = asRecord(params.update);
    if (
      !session ||
      !id ||
      !update ||
      ![
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
      ].includes(String(update.sessionUpdate))
    )
      return null;
    const taskKey = key(session, id);
    const task: Task = tasks.get(taskKey) ?? {
      id: taskKey,
      events: [],
      truncated: false,
    };
    const parentId = asString(params.toolCallId);
    const parentKey = parentId ? key(session, parentId) : undefined;
    if (parentKey && task.parent && task.parent !== parentKey) return null;
    task.parent ??= parentKey;
    task.agentType = asString(params.agentType) ?? task.agentType;
    const childId = asString(update.toolCallId);
    if (
      task.parent &&
      childId &&
      task.parent !== key(session, childId) &&
      (update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update")
    ) {
      const identity = key(session, childId);
      if (!owners.has(identity)) {
        const cached = parents.get(identity);
        if (cached) {
          const restored = { ...cached, sessionUpdate: cached.type };
          const signature = JSON.stringify(restored);
          task.events.push({
            at: Number.NEGATIVE_INFINITY,
            update: restored,
            signature,
          });
          bufferedCharacters += signature.length;
        }
      }
      remember(owners, identity, taskKey);
    }
    const timestamp =
      typeof params.timestamp === "number" && Number.isFinite(params.timestamp)
        ? params.timestamp
        : Date.now();
    const signature = JSON.stringify([params.timestamp, update]);
    if (
      params.timestamp === undefined ||
      !task.events.some((event) => event.signature === signature)
    ) {
      task.events.push({ at: timestamp, update, signature });
      bufferedCharacters += signature.length;
      task.events.sort((a, b) => a.at - b.at);
      while (task.events.length > 500) {
        bufferedCharacters -= task.events.shift()!.signature.length;
        task.truncated = true;
      }
    }
    tasks.set(taskKey, task);
    while (tasks.size > 1024) {
      const oldest = tasks.keys().next().value!;
      bufferedCharacters -= tasks
        .get(oldest)!
        .events.reduce((sum, event) => sum + event.signature.length, 0);
      tasks.delete(oldest);
    }
    for (const cached of tasks.values()) {
      while (bufferedCharacters > 4 * 1024 * 1024 && cached.events.length) {
        bufferedCharacters -= cached.events.shift()!.signature.length;
        cached.truncated = true;
      }
      if (bufferedCharacters <= 4 * 1024 * 1024) break;
    }
    const parent = task.parent ? parents.get(task.parent) : undefined;
    if (!parent || !spawner.test(toolNameOf(parent) ?? ""))
      return { type: "agent_extension", method, params };
    return {
      type: "tool_call_update",
      sessionId: session,
      toolCallId: parent.toolCallId,
      absorbedToolCallIds: absorbedTools(parent),
      subagent: presentation(parent),
    };
  }
  const enhance = (event: AcpSessionEvent): AcpSessionEvent => {
    if (event.type !== "tool_call" && event.type !== "tool_call_update")
      return event;
    const id = key(event.sessionId, event.toolCallId);
    const ownerKey = owners.get(id);
    const owner = ownerKey ? tasks.get(ownerKey) : undefined;
    if (owner?.parent) {
      const routed = childNotification("_subagent/update", {
        sessionId: event.sessionId,
        taskId: (JSON.parse(owner.id) as [string, string])[1],
        toolCallId: (JSON.parse(owner.parent) as [string, string])[1],
        update: { ...event, sessionUpdate: event.type },
      });
      // Until the parent is proven, keep the ordinary card visible as well.
      if (routed?.type === "tool_call_update") return routed;
    }
    const previous = parents.get(id);
    let merged: ToolEvent = {
      ...previous,
      ...event,
      ...Object.fromEntries(
        Object.entries(previous ?? {}).filter(
          ([field]) => !Object.hasOwn(event, field),
        ),
      ),
      _meta: {
        ...previous?._meta,
        ...event._meta,
        codeAgentCLI: {
          ...asRecord(previous?._meta?.codeAgentCLI),
          ...asRecord(event._meta?.codeAgentCLI),
        },
      },
    };
    if (
      (previous?.status === "completed" || previous?.status === "failed") &&
      (event.status === "pending" || event.status === "in_progress")
    ) {
      merged = { ...merged, status: previous.status };
    }
    if (!hasInput(merged.rawInput) && hasInput(previous?.rawInput))
      merged = { ...merged, rawInput: previous!.rawInput };
    const presented: ToolEvent = {
      ...event,
      ...("rawInput" in merged ? { rawInput: merged.rawInput } : {}),
      ...inputPresentation(merged.rawInput, merged.title),
    };
    remember(parents, id, merged);
    const name = toolNameOf(merged);
    if (!name) return presented;
    if (!spawner.test(name)) return { ...presented, toolName: name };
    // Missing live parent IDs may only be recovered from explicit history identity.
    const agentId = asString(object(merged.rawOutput)?.agentId);
    const orphan = agentId
      ? tasks.get(key(event.sessionId, agentId))
      : undefined;
    if (orphan && !orphan.parent) orphan.parent = id;
    return {
      ...presented,
      ...(merged.status ? { status: merged.status } : {}),
      toolName: name,
      absorbedToolCallIds: absorbedTools(merged),
      subagent: presentation(merged),
    };
  };
  return {
    refreshSessionInfoAfterPrompt: true,
    deriveEvents(event) {
      if (event.type === "plan") {
        remember(planSignatures, event.sessionId, planSignature(event.entries));
        return [];
      }
      if (event.type !== "tool_call" && event.type !== "tool_call_update")
        return [];
      const merged = parents.get(key(event.sessionId, event.toolCallId));
      if (
        !merged ||
        toolNameOf(merged) !== "TodoWrite" ||
        merged.status !== "completed"
      )
        return [];
      const todos = object(merged.rawInput)?.todos;
      if (!Array.isArray(todos)) return [];
      const entries: PlanEntry[] = [];
      for (const value of todos as unknown[]) {
        const todo = asRecord(value);
        if (
          !todo ||
          typeof todo.content !== "string" ||
          !todo.content.trim() ||
          (todo.status !== "pending" &&
            todo.status !== "in_progress" &&
            todo.status !== "completed") ||
          (todo.priority !== undefined &&
            todo.priority !== "high" &&
            todo.priority !== "medium" &&
            todo.priority !== "low")
        )
          return [];
        entries.push({
          content: todo.content,
          status: todo.status,
          priority: todo.priority ?? "medium",
        });
      }
      const signature = planSignature(entries);
      if (planSignatures.get(event.sessionId) === signature) return [];
      remember(planSignatures, event.sessionId, signature);
      return [{ type: "plan", sessionId: event.sessionId, entries }];
    },
    requireConfigurationConfirmation: true,
    normalizeConfigOptions,
    normalizeServerRequest: (method, params) =>
      method === "elicitation/create" &&
      params.mode === undefined &&
      asRecord(params.requestedSchema) &&
      !("url" in params)
        ? { ...params, mode: "form" }
        : params,
    enhanceEvent: enhance,
    translateNotification: childNotification,
  };
}
