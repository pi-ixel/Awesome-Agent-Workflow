import type { AgentCommandEntry } from "./acpProtocol.ts";

/** MCP 服务器条目（名字 + 工具数）。 */
export interface McpServerEntry {
  readonly name: string;
  readonly toolCount: number;
}

/** runtime 合并快照：输入区状态行与悬停明细的数据源。 */
export interface RuntimeSnapshot {
  readonly agentProfile: string | null;
  readonly displayName: string | null;
  readonly modelProfileId: string | null;
  /** runtimeDetails.model.name（比 profile id 友好；缺失回落 profile id）。 */
  readonly modelName: string | null;
  readonly modelProvider: string | null;
  readonly maxContextTokens: number | null;
  readonly skillInvocations?: Readonly<Record<string, string>>;
  readonly skillNames: readonly string[];
  readonly toolNames: readonly string[];
  readonly skillSources: readonly { source: string; count: number }[];
  readonly mcpServers: readonly McpServerEntry[];
  readonly mcpFailures: readonly {
    readonly name: string;
    readonly error: string;
  }[];
}

/** usage 快照（主 agent 最新一次 LLM 调用）。 */
export interface UsageSnapshot {
  readonly sourceLabel?: string;
  readonly pct: number | null;
  /** Current context only; never cumulative session consumption. */
  readonly contextUsed: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly maxContextTokens: number | null;
  readonly totalSessionTokens: number | null;
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
  readonly lastSignal: TurnSignal;
  /** 事件流里最近出现的会话 id（用于识别主 agent 用量）。 */
  readonly lastSessionId: string | null;
}
