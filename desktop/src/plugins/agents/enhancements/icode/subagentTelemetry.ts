import { nonnegativeInteger } from "../../../../shared/valueGuards.ts";
import type { SubagentCompaction, SubagentToolPresentation } from "../../../acpRuntime/types.ts";

/** Wire meanings verified against ICode InvocationProgress and compaction events. */
export function subagentTelemetry(
  method: string,
  params: Readonly<Record<string, unknown>>,
  previous: SubagentToolPresentation | undefined,
): Partial<SubagentToolPresentation> | null {
  const invocation = params.invocationId as string;
  if (method === "_chrys/sub_agent_progress") {
    const fields: Partial<
      Record<
        "toolCalls" | "contextTokens" | "totalTokens" | "unreportedAttempts",
        number
      >
    > = {};
    for (const [wire, field] of [
      ["toolCallCount", "toolCalls"],
      ["totalTokens", "contextTokens"],
      ["totalUsageTokens", "totalTokens"],
      ["usageUnreportedAttempts", "unreportedAttempts"],
    ] as const) {
      const value = params[wire];
      if (nonnegativeInteger(value)) fields[field] = value;
    }
    if (!Object.keys(fields).length) return null;
    return {
      progress: {
        ...(previous?.progress?.id === invocation ? previous.progress : {}),
        id: invocation,
        ...fields,
      },
    };
  }
  const started = method === "_chrys/sub_agent_compaction_started";
  const finished = method === "_chrys/sub_agent_compaction_finished";
  const committed = method === "_chrys/sub_agent_compaction_committed";
  if (!started && !finished && !committed) return null;
  if (typeof params.compactionId !== "string" || !params.compactionId)
    return null;
  const id = JSON.stringify([invocation, params.compactionId]);
  const records = previous?.compactions ?? [];
  const old = records.find((record) => record.id === id);
  const state: SubagentCompaction["state"] =
    committed || old?.state === "committed"
      ? "committed"
      : finished
        ? params.outcome === "ok"
          ? "awaiting_commit"
          : params.outcome === "failed"
            ? "failed"
            : "finished"
        : (old?.state ?? "running");
  const record: SubagentCompaction = {
    ...old,
    id,
    state,
    ...(typeof params.phase === "string"
      ? { stage: params.phase === "phase4" ? "上下文摘要" : params.phase }
      : {}),
    ...(finished && typeof params.outcome === "string"
      ? { outcome: params.outcome }
      : {}),
    ...(finished &&
    typeof params.durationMs === "number" &&
    Number.isFinite(params.durationMs) &&
    params.durationMs >= 0
      ? { durationMs: params.durationMs }
      : {}),
    ...(finished && typeof params.formatViolation === "string"
      ? { warning: params.formatViolation }
      : {}),
    ...(finished && typeof params.failureReason === "string"
      ? { failureReason: params.failureReason }
      : {}),
  };
  return {
    compactions: old
      ? records.map((item) => (item.id === id ? record : item))
      : [...records, record],
  };
}
