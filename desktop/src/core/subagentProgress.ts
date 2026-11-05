export interface SubagentProgress {
  readonly id: string;
  readonly toolCalls?: number;
  readonly contextTokens?: number;
  readonly totalTokens?: number;
  readonly unreportedAttempts?: number;
}

export interface SubagentCompaction {
  readonly id: string;
  readonly state:
    "running" | "awaiting_commit" | "committed" | "failed" | "finished";
  readonly stage?: string;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly warning?: string;
  readonly failureReason?: string;
}

export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
