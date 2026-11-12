import type { PromptUsage } from "../../../contracts/acp/protocol.ts";

export interface TurnUsage extends PromptUsage {
  readonly basis: "prompt-total";
  readonly startsAtZero?: true;
}

export type TurnUsageDetails = Pick<
  TurnUsage,
  "inputTokens" | "outputTokens" | "totalTokens" | "cachedReadTokens"
> & { readonly cacheHitBasis?: "total" };

export function sessionUsageDelta(
  current: TurnUsage,
  previous: TurnUsage | undefined,
): TurnUsageDetails | null {
  if (!previous && !current.startsAtZero) return null;
  const inputTokens = current.inputTokens - (previous?.inputTokens ?? 0);
  const outputTokens = current.outputTokens - (previous?.outputTokens ?? 0);
  const totalTokens = current.totalTokens - (previous?.totalTokens ?? 0);
  const cachedReadTokens =
    current.cachedReadTokens !== undefined &&
    (!previous || previous.cachedReadTokens !== undefined)
      ? current.cachedReadTokens - (previous?.cachedReadTokens ?? 0)
      : undefined;
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    totalTokens < 0 ||
    (cachedReadTokens !== undefined && cachedReadTokens < 0)
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
    cacheHitBasis: "total",
  };
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
