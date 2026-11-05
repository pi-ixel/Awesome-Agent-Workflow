import type { AgentUsageReport } from "../acp/usage.ts";
import { createStoreView } from "./storeView.ts";
/**
 * 会话运行时状态：输入区状态行与消息流状态的数据源。
 *
 * 三块状态（全部只读展示，不发协议请求）：
 * - runtime：适配器输出的通用字段按出现的字段合并。
 * - usage：标准 ACP 上下文优先；扩展 scope 由适配器判定。
 *   子代理只刷新会话累计消耗，不覆盖主会话窗口或当前调用计数。
 * - turn：轮次状态机。起止由桥接层（sessionBridge 订阅 sessionStore 的
 *   isAgentRunning）驱动 beginTurn/endTurn；过程中的「思考中 / 工具运行
 *   中(n) / 生成中」由事件流自身推导——运行中的工具计数优先于文字信号，
 *   thought chunk → 思考中，agent message chunk → 生成中。
 *
 * store 之间不互相 import（约定 §2.4）：本 store 只消费 AcpSessionEvent，
 * 与 sessionStore 的联动全部发生在组装层。
 */
import { create } from "zustand";
import { createUsageDiagnostics } from "../core/usageDiagnostics.ts";

import type { AcpSessionEvent } from "../acp/session.ts";
import type { AgentCommandEntry } from "../acp/types.ts";

export type {
  RuntimeSnapshot,
  McpServerEntry,
} from "../acp/runtimeSnapshot.ts";
import type { RuntimeSnapshot } from "../acp/runtimeSnapshot.ts";

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

export interface RuntimeStatusState {
  readonly runtime: RuntimeSnapshot;
  readonly usage: UsageSnapshot | null;
  /**
   * 当前用量快照的来源：ICode 扩展（补充明细）或标准
   * usage_update（上下文占用口径）——两者并存时以标准版为准，
   * 标准版始终优先，扩展只补充明细。
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
  handleSessionEvent: (event: AcpSessionEvent) => void;
  /** 轮次开始（桥接层驱动：sessionStore.isAgentRunning 翻 true）。 */
  beginTurn: () => void;
  /** 轮次结束：清运行中工具计数与文字信号（桥接层驱动）。 */
  endTurn: () => void;
  /** 会话切换 / 断开：全部复位。 */
  reset: () => void;
}

const initialRuntime: RuntimeSnapshot = {
  agentProfile: null,
  displayName: null,
  modelProfileId: null,
  modelName: null,
  modelProvider: null,
  maxContextTokens: null,
  skillNames: [],
  toolNames: [],
  skillSources: [],
  mcpServers: [],
  mcpFailures: [],
};

const initialState = {
  runtime: initialRuntime,
  usage: null as UsageSnapshot | null,
  usageSource: null as "extension" | "standard" | null,
  availableCommands: [] as readonly AgentCommandEntry[],
  isTurnActive: false,
  runningToolCount: 0,
  lastSignal: null as TurnSignal,
  lastSessionId: null as string | null,
};

/** 运行中工具的 id 集合（store 外部不可见，事件流维护）。 */

/** Scope is normalized by the adapter; source IDs have no generic semantics. */
function isMainAgentUsage(usage: AgentUsageReport): boolean {
  return usage.scope !== "subagent";
}

function pickUsage(usage: AgentUsageReport): UsageSnapshot {
  return {
    sourceLabel: usage.sourceLabel,
    contextUsed:
      typeof usage.contextUsed === "number" ? usage.contextUsed : null,
    pct: typeof usage.pct === "number" ? usage.pct : null,
    inputTokens:
      typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    outputTokens:
      typeof usage.outputTokens === "number" ? usage.outputTokens : null,
    totalTokens:
      typeof usage.totalTokens === "number" ? usage.totalTokens : null,
    maxContextTokens:
      typeof usage.maxContextTokens === "number"
        ? usage.maxContextTokens
        : null,
    totalSessionTokens:
      typeof usage.totalSessionTokens === "number"
        ? usage.totalSessionTokens
        : null,
    cacheHitTokens:
      typeof usage.cacheHitTokens === "number" ? usage.cacheHitTokens : null,
  };
}

/** 标准 usage_update（上下文占用口径）→ UsageSnapshot；token 明细该通知不提供。 */
function pickStandardUsage(
  contextSize: number | null,
  contextUsed: number | null,
): UsageSnapshot {
  const pct =
    contextSize !== null && contextUsed !== null && contextSize > 0
      ? Math.round((contextUsed / contextSize) * 1000) / 10
      : null;
  return {
    pct,
    contextUsed,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    maxContextTokens: contextSize,
    totalSessionTokens: null,
    cacheHitTokens: null,
  };
}

export const createRuntimeStatusStore = () => {
  const runningToolIds = new Set<string>();
  const usageDiagnostics = createUsageDiagnostics();
  return create<RuntimeStatusState>()((set, get) => ({
    ...initialState,
    handleSessionEvent: (event) => {
      switch (event.type) {
        case "agent_runtime": {
          set((state) => ({
            lastSessionId: event.sessionId,
            runtime: { ...state.runtime, ...event.runtime },
          }));
          return;
        }
        case "agent_usage": {
          const raw = event.usage;
          const used = raw.contextUsed ?? null;
          usageDiagnostics.record({
            sessionId: event.sessionId,
            source: "extension",
            sourceId: raw.usageSourceId,
            decision: isMainAgentUsage(raw)
              ? get().usageSource === "standard"
                ? "ignored-source-priority"
                : "selected"
              : "ignored-subagent",
            used,
            capacity: raw.maxContextTokens ?? get().runtime.maxContextTokens,
            sessionTotal: raw.totalSessionTokens ?? null,
            reportedPercent: raw.pct ?? null,
            details: {
              reportedCapacity: raw.maxContextTokens ?? null,
              runtimeCapacity: get().runtime.maxContextTokens,
              input: raw.inputTokens ?? null,
              output: raw.outputTokens ?? null,
              cacheHit: raw.cacheHitTokens ?? null,
              sessionInput: raw.totalSessionInputTokens ?? null,
              sessionOutput: raw.totalSessionOutputTokens ?? null,
              sessionCacheHit: raw.totalSessionCacheHitTokens ?? null,
              localEstimate: raw.localTokens ?? null,
              calibrationRatio: raw.calibrationRatio ?? null,
              systemOverhead: raw.systemOverheadTokens ?? null,
            },
            basis: raw.contextUsed !== undefined ? "latest-call" : "missing",
          });
          set((state) => ({
            lastSessionId: event.sessionId,
            usage: isMainAgentUsage(event.usage)
              ? state.usageSource === "standard" && state.usage
                ? {
                    ...pickUsage(event.usage),
                    contextUsed: state.usage.contextUsed,
                    maxContextTokens: state.usage.maxContextTokens,
                    pct: state.usage.pct,
                    sourceLabel: state.usage.sourceLabel,
                  }
                : pickUsage(event.usage)
              : typeof raw.totalSessionTokens === "number"
                ? {
                    ...(state.usage ??
                      pickUsage({ sessionId: event.sessionId })),
                    totalSessionTokens: raw.totalSessionTokens,
                  }
                : state.usage,
            ...(isMainAgentUsage(event.usage) &&
            state.usageSource !== "standard"
              ? { usageSource: "extension" as const }
              : {}),
          }));
          return;
        }
        case "usage_update": {
          usageDiagnostics.record({
            sessionId: event.sessionId,
            source: "standard",
            decision: "selected",
            used: event.contextUsed,
            capacity: event.contextSize,
            sessionTotal: null,
            reportedPercent: null,
            basis: "context",
          });
          set((state) => ({
            lastSessionId: event.sessionId,
            usage: {
              ...pickStandardUsage(event.contextSize, event.contextUsed),
              sourceLabel: "标准 ACP 上下文",
              totalTokens: state.usage?.totalTokens ?? null,
              inputTokens: state.usage?.inputTokens ?? null,
              outputTokens: state.usage?.outputTokens ?? null,
              cacheHitTokens: state.usage?.cacheHitTokens ?? null,
              totalSessionTokens: state.usage?.totalSessionTokens ?? null,
            },
            usageSource: "standard",
          }));
          return;
        }
        case "available_commands": {
          set({
            lastSessionId: event.sessionId,
            availableCommands: event.commands,
          });
          return;
        }
        case "tool_call":
        case "tool_call_update": {
          // Presentation-only updates do not restart a completed parent tool.
          if (event.type === "tool_call_update" && event.status === undefined)
            return;
          const status = event.status ?? "in_progress";
          if (status === "in_progress" || status === "pending") {
            runningToolIds.add(event.toolCallId);
          } else {
            runningToolIds.delete(event.toolCallId);
          }
          set({ runningToolCount: runningToolIds.size });
          return;
        }
        case "agent_thought_chunk": {
          set({ lastSessionId: event.sessionId, lastSignal: "thought" });
          return;
        }
        case "agent_message_chunk": {
          set({ lastSessionId: event.sessionId, lastSignal: "message" });
          return;
        }
        default:
          return;
      }
    },
    beginTurn: () => {
      runningToolIds.clear();
      set({ isTurnActive: true, runningToolCount: 0, lastSignal: null });
    },
    endTurn: () => {
      runningToolIds.clear();
      set({ isTurnActive: false, runningToolCount: 0, lastSignal: null });
    },
    reset: () => {
      usageDiagnostics.reset();
      runningToolIds.clear();
      set({ ...initialState });
    },
  }));
};

/**
 * 轮次状态标签：输入区状态章的文案来源。优先级——运行中工具 > 文字信号 >
 * 轮次刚开启（无任何信号时按「思考中」呈现，与 agent 实际行为一致：模型
 * 首个输出之前正是在思考）。轮次未激活时由调用方展示空闲态。
 */
export function turnStatusLabel(
  state: Pick<RuntimeStatusState, "runningToolCount" | "lastSignal">,
): string {
  if (state.runningToolCount > 0) {
    return `工具运行中 ${state.runningToolCount}`;
  }
  if (state.lastSignal === "thought") {
    return "思考中";
  }
  if (state.lastSignal === "message") {
    return "生成中";
  }
  return "思考中";
}

const runtimeView = createStoreView(createRuntimeStatusStore());
export const useRuntimeStatusStore = runtimeView.view;
export const selectRuntimeStatusStore = runtimeView.select;
