import type { AgentCommandEntry, RuntimeSnapshot } from "../../acpRuntime/types.ts";

/** 上下文占用、调用明细与会话累计的展示快照。 */
export interface UsageSnapshot {
  readonly sourceLabel?: string;
  readonly basis?: "prompt-total";
  readonly pct: number | null;
  /** Current context only; never cumulative session consumption. */
  readonly contextUsed: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly maxContextTokens: number | null;
  readonly totalSessionTokens: number | null;
  readonly totalSessionInputTokens?: number;
  readonly totalSessionOutputTokens?: number;
  readonly totalSessionCacheHitTokens?: number;
  readonly cacheHitTokens: number | null;
}

/** 轮内文字信号：最近一次内容 chunk 的种类。 */
export type TurnSignal = "thought" | "message" | null;

export interface RuntimeStatusValues {
  readonly runtime: RuntimeSnapshot;
  readonly usage: UsageSnapshot | null;
  /**
   * 标准 usage_update 提供上下文占用，适配器扩展补充其余明细。
   */
  readonly usageSource: "extension" | "standard" | null;
  /** agent 侧斜杠命令清单（available_commands_update 的最新快照）。 */
  readonly availableCommands: readonly AgentCommandEntry[];
  /** 轮次进行中（beginTurn 到 endTurn 之间）。 */
  readonly isTurnActive: boolean;
  readonly runningToolCount: number;
  readonly outputTokensPerSecond: number | null;
  readonly lastSignal: TurnSignal;
  /** 事件流里最近出现的会话 id（用于识别主 agent 用量）。 */
  readonly lastSessionId: string | null;
}
