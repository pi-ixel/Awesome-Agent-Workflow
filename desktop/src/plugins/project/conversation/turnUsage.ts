import type { PromptUsage } from "../../../contracts/acp/protocol.ts";

export interface TurnUsage extends PromptUsage {
  readonly basis: "prompt-total";
  readonly startsAtZero?: true;
}

export type TurnTokenCounts = Pick<TurnUsage, "inputTokens" | "outputTokens">;

export function sessionUsageDelta(
  current: TurnUsage,
  previous: TurnUsage | undefined,
): TurnTokenCounts | null {
  if (!previous) {
    return current.startsAtZero
      ? { inputTokens: current.inputTokens, outputTokens: current.outputTokens }
      : null;
  }
  const inputTokens = current.inputTokens - previous.inputTokens;
  const outputTokens = current.outputTokens - previous.outputTokens;
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    current.totalTokens < previous.totalTokens ||
    (current.cachedReadTokens !== undefined &&
      previous.cachedReadTokens !== undefined &&
      current.cachedReadTokens < previous.cachedReadTokens)
  ) {
    return null;
  }
  return { inputTokens, outputTokens };
}

export function parseTurnUsage(value: unknown): TurnUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (
    !valid(raw.inputTokens) ||
    !valid(raw.outputTokens) ||
    !valid(raw.totalTokens)
  )
    return undefined;
  return {
    basis: "prompt-total",
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: raw.totalTokens,
    ...(valid(raw.cachedReadTokens)
      ? { cachedReadTokens: raw.cachedReadTokens }
      : {}),
    ...(raw.basis === "prompt-total" && raw.startsAtZero === true
      ? { startsAtZero: true }
      : {}),
  };
}
