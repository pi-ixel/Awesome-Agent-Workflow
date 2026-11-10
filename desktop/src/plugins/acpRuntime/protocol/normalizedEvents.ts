import type { ToolKind } from "../../../contracts/acp/protocol.ts";

import type { ToolLocation } from "../../../contracts/acp/toolLocations.ts";

/** 可供输入框展示的 Agent 斜杠命令。 */
export interface AgentCommandEntry {
  readonly name: string;
  readonly description: string | null;
  readonly inputHint: string | null;
}



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

export type EditPayload =
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
    };

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
