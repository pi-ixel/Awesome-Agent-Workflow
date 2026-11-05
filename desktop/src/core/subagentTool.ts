import {
  parseSubagentProgress,
  parseSubagentCompactions,
  type SubagentProgress,
  type SubagentCompaction,
} from "./subagentProgress.ts";
/** Read-only presentation of existing tool evidence, not a child-session API. */
export interface SubagentToolEvidence {
  readonly subagent?: SubagentToolPresentation | null;
  readonly title: string;
  readonly toolCallId?: string;
  readonly toolKind?: string | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: unknown;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface SubagentToolRecord {
  readonly id: string;
  readonly name: string;
  readonly state: "running" | "returned";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: unknown;
  readonly durationMs?: number;
}

export interface SubagentToolPresentation {
  readonly progress?: SubagentProgress;
  readonly compactions?: readonly SubagentCompaction[];
  readonly tools?: readonly SubagentToolRecord[];
  readonly phase?: "running" | "paused" | "retrying" | "aborted";
  readonly detail?: string;
  readonly name: string;
  readonly task: string;
  readonly stats: {
    readonly toolCalls: number;
    readonly contextTokens: number;
    readonly totalTokens: number;
  } | null;
}

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
                ...(Object.hasOwn(tool, "input") ? { input: tool.input } : {}),
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
