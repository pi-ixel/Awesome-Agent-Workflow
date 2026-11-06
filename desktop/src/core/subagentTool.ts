import type { ToolKind } from "../acp/types.ts";
import { parseToolLocations, type ToolLocation } from "../acp/toolLocations.ts";

export function childToolKind(value: unknown): ToolKind | undefined {
  const kinds: readonly ToolKind[] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
  ];
  return kinds.find((kind) => kind === value);
}
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
  readonly title?: string;
  readonly kind?: ToolKind;
  readonly content?: unknown;
  readonly locations?: readonly ToolLocation[];
  readonly input?: unknown;
  /** Adapter-supplied display text; null clears the fallback. Never protocol input. */
  readonly inputFallback?: string | null;
  readonly output?: unknown;
  readonly metadata?: unknown;
  readonly durationMs?: number;
  readonly failed?: boolean;
}

export interface SubagentMessage {
  readonly id: string;
  readonly kind: "message" | "thought";
  readonly text: string;
}

export interface SubagentToolPresentation {
  readonly messages?: readonly SubagentMessage[];
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
                ...(childToolKind(tool.kind)
                  ? { kind: childToolKind(tool.kind) }
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
