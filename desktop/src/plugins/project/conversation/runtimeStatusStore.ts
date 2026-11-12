import type { TurnUsage } from "./turnUsage.ts";
import type {
  UsageSnapshot,
  RuntimeStatusValues,
} from "./runtimeStatusTypes.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { AgentUsageReport } from "../../acpRuntime/types.ts";
import { emptyRuntime } from "./viewState.ts";
/**
 * 会话运行时状态：输入区状态行与消息流状态的数据源。
 *
 * 三块状态（全部只读展示，不发协议请求）：
 * - runtime：适配器输出的通用字段按出现的字段合并。
 * - usage：标准 ACP 上下文优先；扩展 scope 由适配器判定。
 *   子代理只刷新会话累计消耗，不覆盖主会话窗口或当前调用计数。
 * - turn：轮次状态机。起止由投影层（projection 订阅 sessionStore 的
 *   isAgentRunning）驱动 beginTurn/endTurn；过程中的「思考中 / 工具运行
 *   中(n) / 生成中」由事件流自身推导——运行中的工具计数优先于文字信号，
 *   thought chunk → 思考中，agent message chunk → 生成中。
 *
 * store 之间不互相 import（约定 §2.4）：本 store 只消费 AcpSessionEvent，
 * 与 sessionStore 的联动全部发生在组装层。
 */
import { create } from "zustand";
import { createUsageDiagnostics } from "./usageDiagnostics.ts";
import { createOutputRate } from "./outputRate.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export type {
  RuntimeSnapshot,
  McpServerEntry,
} from "../../acpRuntime/types.ts";

const sessionCounterKeys = [
  "totalSessionTokens",
  "totalSessionInputTokens",
  "totalSessionOutputTokens",
  "totalSessionCacheHitTokens",
] as const;
type SessionCounters = Partial<Pick<UsageSnapshot, (typeof sessionCounterKeys)[number]>>;

export interface RuntimeStatusState extends RuntimeStatusValues {
  restoreSessionCounters: (counters: SessionCounters) => void;
  setTurnUsage: (usage: TurnUsage | null) => void;
  handleSessionEvent: (event: AcpSessionEvent) => void;
  setOutputRatePaused: (paused: boolean) => void;
  setOutputRateEnabled: (enabled: boolean) => void;
  /** 轮次开始（桥接层驱动：sessionStore.isAgentRunning 翻 true）。 */
  beginTurn: () => void;
  /** 轮次结束：清运行中工具计数与文字信号（桥接层驱动）。 */
  endTurn: () => void;
  /** 会话切换 / 断开：全部复位。 */
  reset: () => void;
}

/** 运行中工具的 id 集合（store 外部不可见，事件流维护）。 */

/** Scope is normalized by the adapter; source IDs have no generic semantics. */
function isMainAgentUsage(usage: AgentUsageReport): boolean {
  return usage.scope !== "subagent";
}

/** Session counters may arrive on main or subagent reports; absent fields do not clear them. */
function pickSessionCounters(
  usage: SessionCounters,
  previous?: UsageSnapshot | null,
) {
  const counters: Partial<Record<(typeof sessionCounterKeys)[number], number>> = {};
  for (const key of sessionCounterKeys) {
    const value = usage[key];
    const selected =
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : previous?.[key];
    if (selected != null) counters[key] = selected;
  }
  return counters;
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
    totalSessionTokens: null,
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

export const createRuntimeStatusStore = (logger?: Logger) => {
  const runningToolIds = new Set<string>();
  const usageDiagnostics = createUsageDiagnostics(logger);
  let outputRatePaused = false;
  let outputRateEnabled = false;
  const outputRate = createOutputRate((rate) => {
    if (store.getState().outputTokensPerSecond !== rate) {
      store.setState({ outputTokensPerSecond: rate });
    }
  });
  const store = create<RuntimeStatusState>()((set, get) => ({
    ...emptyRuntime,
    restoreSessionCounters: (counters) => set((state) => ({
      usage: {
        ...(state.usage ?? pickStandardUsage(null, null)),
        ...pickSessionCounters(counters),
        ...pickSessionCounters(state.usage ?? {}),
      },
    })),
    setTurnUsage: (usage) =>
      set((state) =>
        usage === null
          ? { usage: null, usageSource: null }
          : {
              usage: {
                ...pickStandardUsage(
                  state.usage?.maxContextTokens ?? state.runtime.maxContextTokens,
                  state.usageSource === "standard"
                    ? state.usage?.contextUsed ?? null
                    : null,
                ),
                basis: "prompt-total",
                sourceLabel: "标准 ACP 上下文",
                totalSessionTokens: usage.totalTokens,
                totalSessionInputTokens: usage.inputTokens,
                totalSessionOutputTokens: usage.outputTokens,
                totalSessionCacheHitTokens: usage.cachedReadTokens,
              },
            },
      ),
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
          if (get().usage?.basis === "prompt-total") return;
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
                    ...pickSessionCounters(raw, state.usage),
                    contextUsed: state.usage.contextUsed,
                    maxContextTokens: state.usage.maxContextTokens,
                    pct: state.usage.pct,
                    sourceLabel: state.usage.sourceLabel,
                  }
                : {
                    ...pickUsage(event.usage),
                    ...pickSessionCounters(raw, state.usage),
                  }
              : Object.keys(pickSessionCounters(raw)).length > 0
                ? {
                    ...(state.usage ??
                      pickUsage({ sessionId: event.sessionId })),
                    ...pickSessionCounters(raw, state.usage),
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
              ...(state.usage?.basis === "prompt-total"
                ? { basis: "prompt-total" as const }
                : {}),
              sourceLabel: "标准 ACP 上下文",
              totalTokens: state.usage?.totalTokens ?? null,
              inputTokens: state.usage?.inputTokens ?? null,
              outputTokens: state.usage?.outputTokens ?? null,
              cacheHitTokens: state.usage?.cacheHitTokens ?? null,
              ...pickSessionCounters({}, state.usage),
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
          if (runningToolIds.size > 0) outputRate.reset();
          set({ runningToolCount: runningToolIds.size });
          return;
        }
        case "agent_thought_chunk":
        case "agent_message_chunk": {
          const channel =
            event.type === "agent_thought_chunk" ? "thought" : "message";
          if (
            get().isTurnActive &&
            outputRateEnabled &&
            !outputRatePaused &&
            runningToolIds.size === 0 &&
            event.receivedAt !== undefined
          ) {
            outputRate.append(channel, event.text, event.receivedAt);
          }
          set({ lastSessionId: event.sessionId, lastSignal: channel });
          return;
        }
        default:
          return;
      }
    },
    setOutputRateEnabled: (enabled) => {
      if (enabled === outputRateEnabled) return;
      outputRateEnabled = enabled;
      if (!enabled) outputRate.reset();
    },
    setOutputRatePaused: (paused) => {
      if (paused === outputRatePaused) return;
      outputRatePaused = paused;
      if (paused) outputRate.reset();
    },
    beginTurn: () => {
      outputRate.reset();
      runningToolIds.clear();
      set({ isTurnActive: true, runningToolCount: 0, lastSignal: null });
    },
    endTurn: () => {
      outputRate.reset();
      runningToolIds.clear();
      set({ isTurnActive: false, runningToolCount: 0, lastSignal: null });
    },
    reset: () => {
      outputRate.reset();
      outputRatePaused = false;
      usageDiagnostics.reset();
      runningToolIds.clear();
      set({ ...emptyRuntime });
    },
  }));
  return store;
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
