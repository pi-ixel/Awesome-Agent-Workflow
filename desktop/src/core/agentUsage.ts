/** Optional counters: absence means unknown. Call totals are never context usage. */
export interface AgentUsageReport {
  readonly sessionId: string;
  readonly agentProfile?: string;
  readonly sourceLabel?: string;
  readonly contextUsed?: number;
  readonly contextBasis?: "reported" | "estimated";
  readonly scope?: "session" | "subagent";
  readonly usageSourceId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly pct?: number;
  readonly maxContextTokens?: number;
  readonly totalSessionTokens?: number;
  readonly totalSessionInputTokens?: number;
  readonly totalSessionOutputTokens?: number;
  readonly cacheHitTokens?: number;
  readonly totalSessionCacheHitTokens?: number;
  readonly localTokens?: number;
  readonly calibrationRatio?: number;
  readonly systemOverheadTokens?: number;
}
