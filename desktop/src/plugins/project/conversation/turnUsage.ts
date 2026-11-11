import type { PromptUsage } from "../../../contracts/acp/protocol.ts";

export interface TurnUsage extends PromptUsage {
  readonly basis: "prompt-total";
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
  };
}
