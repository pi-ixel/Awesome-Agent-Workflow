import { parseToolKind } from "../../../contracts/acp/tools.ts";
import { parseToolLocations } from "../../../contracts/acp/toolLocations.ts";
import { nonnegativeInteger } from "../../../shared/valueGuards.ts";
import type {
  SubagentCompaction,
  SubagentMessage,
  SubagentProgress,
  SubagentToolEvidence,
  SubagentToolPresentation,
  SubagentToolRecord,
} from "../../acpRuntime/types.ts";

/** Presentation is supplied by the owning adapter, never inferred by the UI. */
export function subagentTool(
  item: SubagentToolEvidence,
): SubagentToolPresentation | null {
  return item.subagent ?? null;
}

/** Same deterministic type-name hash and eight colors as ZCode. */
export function subagentColor(name: string): string {
  const colors = [
    "yellow",
    "red",
    "orange",
    "green",
    "cyan",
    "blue",
    "purple",
    "pink",
  ];
  let hash = 0;
  for (let index = 0; index < name.length; index++)
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  return colors[hash % colors.length]!;
}

export function parseSubagentProgress(
  value: unknown,
): SubagentProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string") return undefined;
  return {
    id: raw.id,
    ...Object.fromEntries(
      ["toolCalls", "contextTokens", "totalTokens", "unreportedAttempts"]
        .filter((field) => nonnegativeInteger(raw[field]))
        .map((field) => [field, raw[field]]),
    ),
  };
}

export function parseSubagentCompactions(
  value: unknown,
): readonly SubagentCompaction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): SubagentCompaction[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      (raw.state !== "running" &&
        raw.state !== "awaiting_commit" &&
        raw.state !== "committed" &&
        raw.state !== "failed" &&
        raw.state !== "finished")
    )
      return [];
    return [
      {
        id: raw.id,
        state: raw.state,
        ...Object.fromEntries(
          ["stage", "outcome", "warning", "failureReason"]
            .filter((field) => typeof raw[field] === "string")
            .map((field) => [field, raw[field]]),
        ),
        ...(typeof raw.durationMs === "number" &&
        Number.isFinite(raw.durationMs) &&
        raw.durationMs >= 0
          ? { durationMs: raw.durationMs }
          : {}),
      },
    ];
  });
}

export function parseSubagentPresentation(
  value: unknown,
): SubagentToolPresentation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || typeof item.task !== "string")
    return undefined;
  const stats = item.stats as SubagentToolPresentation["stats"] | undefined;
  if (
    stats !== null &&
    (!stats ||
      ![stats.toolCalls, stats.contextTokens, stats.totalTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ))
  )
    return undefined;
  const phase = item.phase;
  const progress = parseSubagentProgress(item.progress);
  const compactions = parseSubagentCompactions(item.compactions);
  return {
    name: item.name,
    task: item.task,
    stats,
    ...(Array.isArray(item.messages)
      ? {
          messages: item.messages.flatMap((value): SubagentMessage[] => {
            if (!value || typeof value !== "object") return [];
            const message = value as Record<string, unknown>;
            return typeof message.id === "string" &&
              typeof message.text === "string" &&
              (message.kind === "message" || message.kind === "thought")
              ? [{ id: message.id, text: message.text, kind: message.kind }]
              : [];
          }),
        }
      : {}),
    ...(progress ? { progress } : {}),
    ...(compactions ? { compactions } : {}),
    ...(Array.isArray(item.tools)
      ? {
          tools: item.tools.flatMap((raw): SubagentToolRecord[] => {
            if (!raw || typeof raw !== "object") return [];
            const tool = raw as Record<string, unknown>;
            if (
              typeof tool.id !== "string" ||
              typeof tool.name !== "string" ||
              (tool.state !== "running" && tool.state !== "returned")
            )
              return [];
            return [
              {
                id: tool.id,
                name: tool.name,
                state: tool.state,
                ...(typeof tool.title === "string"
                  ? { title: tool.title }
                  : {}),
                ...(parseToolKind(tool.kind)
                  ? { kind: parseToolKind(tool.kind) }
                  : {}),
                ...("content" in tool ? { content: tool.content } : {}),
                ...(Array.isArray(tool.locations)
                  ? { locations: parseToolLocations(tool.locations) }
                  : {}),
                ...(typeof tool.failed === "boolean"
                  ? { failed: tool.failed }
                  : {}),
                ...(Object.hasOwn(tool, "input") ? { input: tool.input } : {}),
                ...(tool.inputFallback === null ||
                typeof tool.inputFallback === "string"
                  ? { inputFallback: tool.inputFallback }
                  : {}),
                ...(Object.hasOwn(tool, "output")
                  ? { output: tool.output }
                  : {}),
                ...(Object.hasOwn(tool, "metadata")
                  ? { metadata: tool.metadata }
                  : {}),
                ...(typeof tool.durationMs === "number" &&
                Number.isFinite(tool.durationMs) &&
                tool.durationMs >= 0
                  ? { durationMs: tool.durationMs }
                  : {}),
              },
            ];
          }),
        }
      : {}),
    ...(phase === "running" ||
    phase === "paused" ||
    phase === "retrying" ||
    phase === "aborted"
      ? { phase }
      : {}),
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
  };
}
