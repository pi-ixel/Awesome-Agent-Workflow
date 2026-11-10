import type { AcpSessionEvent } from "../../../acpRuntime/events.ts";
import { subagentTelemetry } from "./subagentTelemetry.ts";
import type {
  SubagentToolPresentation,
  SubagentToolRecord,
} from "../../../acpRuntime/types.ts";

/** Invocation IDs are only meaningful within the originating ACP session. */
export function createSubagentLifecycle() {
  const parents = new Map<string, string>();
  const presentations = new Map<string, SubagentToolPresentation>();
  const key = (session: string, id: string) => JSON.stringify([session, id]);
  function remember<K, V>(map: Map<K, V>, id: K, value: V) {
    map.set(id, value);
    if (map.size > 2048) map.delete(map.keys().next().value!);
  }
  return {
    merge(
      session: string,
      tool: string,
      inferred: SubagentToolPresentation | null,
    ) {
      const id = key(session, tool);
      const live = presentations.get(id);
      const merged = inferred ? { ...live, ...inferred } : live;
      if (merged) remember(presentations, id, merged);
      return merged;
    },
    translate(
      method: string,
      params: Readonly<Record<string, unknown>>,
    ): AcpSessionEvent | null {
      const session = params.sessionId;
      const invocation = params.invocationId;
      if (typeof session !== "string" || typeof invocation !== "string")
        return null;
      const invocationKey = key(session, invocation);
      if (method === "_chrys/sub_agent_invocation_start") {
        if (typeof params.parentCallId !== "string" || !params.parentCallId)
          return null;
        remember(parents, invocationKey, params.parentCallId);
      }
      const phases: Record<string, SubagentToolPresentation["phase"]> = {
        "_chrys/sub_agent_invocation_start": "running",
        "_chrys/sub_agent_paused": "paused",
        "_chrys/sub_agent_resumed": "running",
        "_chrys/sub_agent_retry_attempt": "retrying",
        "_chrys/sub_agent_aborted": "aborted",
        "_chrys/sub_agent_cascade_aborted": "aborted",
      };
      const phase = phases[method];
      const toolCallId = parents.get(invocationKey);
      const toolStart = method === "_chrys/sub_agent_tool_call_start";
      const toolResult = method === "_chrys/sub_agent_tool_call_result";
      if (!toolCallId) return null;
      const id = key(session, toolCallId);
      const previous = presentations.get(id);
      const telemetry = subagentTelemetry(method, params, previous);
      if (!phase && !toolStart && !toolResult && !telemetry) return null;
      let tools = previous?.tools;
      if (toolStart || toolResult) {
        if (
          typeof params.callId !== "string" ||
          !params.callId ||
          typeof params.toolName !== "string"
        )
          return null;
        const childId = key(invocation, params.callId);
        const existing = tools?.find((tool) => tool.id === childId);
        const record: SubagentToolRecord = {
          ...existing,
          id: childId,
          name: params.toolName,
          state:
            toolResult || existing?.state === "returned"
              ? "returned"
              : "running",
          ...(toolStart && Object.hasOwn(params, "args")
            ? { input: params.args }
            : {}),
          ...(toolResult && Object.hasOwn(params, "result")
            ? { output: params.result }
            : {}),
          ...(toolResult && Object.hasOwn(params, "metadata")
            ? { metadata: params.metadata }
            : {}),
          ...(toolResult &&
          typeof params.durationMs === "number" &&
          Number.isFinite(params.durationMs) &&
          params.durationMs >= 0
            ? { durationMs: params.durationMs }
            : {}),
        };
        tools = existing
          ? tools!.map((tool) => (tool.id === childId ? record : tool))
          : [...(tools ?? []), record];
      }
      const detail =
        phase === "running"
          ? ""
          : [params.reason, params.message, params.lastError]
              .filter(
                (value): value is string =>
                  typeof value === "string" && value.length > 0,
              )
              .join("；");
      const subagent: SubagentToolPresentation = {
        ...previous,
        name:
          previous?.name ||
          (typeof params.agentName === "string" ? params.agentName : ""),
        task: previous?.task ?? "",
        stats: previous?.stats ?? null,
        phase: phase ?? previous?.phase,
        detail: phase ? detail : previous?.detail,
        ...(tools ? { tools } : {}),
        ...telemetry,
        ...(method === "_chrys/sub_agent_invocation_start" &&
        previous?.progress?.id !== invocation
          ? { progress: undefined }
          : {}),
      };
      remember(presentations, id, subagent);
      // Never fabricate a child tool row or a terminal status for its parent.
      return {
        type: "tool_call_update",
        sessionId: session,
        toolCallId,
        subagent,
      };
    },
  };
}
