import { createStoreView } from "./storeView.ts";
/**
 * 会话运行时状态 store（src/stores）：iCode 推过来、但此前在 UI 上丢失的
 * 信息统一落点——输入区状态行与消息流状态感的数据源。
 *
 * 三块状态（全部只读展示，不发协议请求）：
 * - runtime：`chrys_runtime` 的字段级合并快照。该通知有三种形状（完整
 *   快照 / SessionReady / AgentRuntimeUpdated partial，见 chrys server.py
 *   _send_runtime_update），partial 只带变化字段，这里按「字段存在才覆盖」
 *   合并；`runtimeDetails` 里的 model / mcp_tools / mcp_failures /
 *   skill_sources 经严格收窄提取（形状随版本变化，解析失败按缺失处理）。
 * - usage：`chrys_usage` 最新一次主 agent 用量（pct = 最近一次调用占当前
 *   模型上下文窗口的百分比）。子代理用量的 usageSourceId 是 invocation id，
 *   与主 agent（= sessionId）不同——非主 agent 的用量不进这里，避免状态行
 *   在父/子窗口间跳动（chrys 对标准 usage_update 也是同样取舍）。
 * - turn：轮次状态机。起止由桥接层（sessionBridge 订阅 sessionStore 的
 *   isAgentRunning）驱动 beginTurn/endTurn；过程中的「思考中 / 工具运行
 *   中(n) / 生成中」由事件流自身推导——运行中的工具计数优先于文字信号，
 *   thought chunk → 思考中，agent message chunk → 生成中。
 *
 * store 之间不互相 import（约定 §2.4）：本 store 只消费 AcpSessionEvent，
 * 与 sessionStore 的联动全部发生在组装层。
 */
import { create } from "zustand";

import type { AcpSessionEvent } from "../acp/session.ts";
import type { ChrysRuntime, ChrysUsageUpdateParams } from "../acp/types.ts";

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
  readonly pct: number | null;
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
  isTurnActive: false,
  runningToolCount: 0,
  lastSignal: null as TurnSignal,
  lastSessionId: null as string | null,
};

/** 运行中工具的 id 集合（store 外部不可见，事件流维护）。 */

// ------------------------------------------------- runtimeDetails 严格收窄

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

/** dict[string, list[string]] → 计数条目（键排序，坏值丢弃）。 */
function countEntries(
  value: unknown,
): readonly { name: string; count: number }[] | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const entries: { name: string; count: number }[] = [];
  for (const [key, tools] of Object.entries(record)) {
    const name = asString(key);
    if (name === null) {
      continue;
    }
    const list = asStringList(tools);
    entries.push({ name, count: list === null ? 0 : list.length });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

/** 从 runtimeDetails 提取 model / mcp / skill 来源信息（坏形状按缺失处理）。 */
function parseRuntimeDetails(details: unknown): {
  modelName: string | null;
  modelProvider: string | null;
  mcpServers: readonly McpServerEntry[];
  mcpFailures: readonly { name: string; error: string }[];
  skillSources: readonly { source: string; count: number }[];
} {
  const record = asRecord(details);
  if (record === null) {
    return {
      modelName: null,
      modelProvider: null,
      mcpServers: [],
      mcpFailures: [],
      skillSources: [],
    };
  }
  const model = asRecord(record["model"]);
  const mcpTools = countEntries(record["mcp_tools"]);
  const failuresRecord = asRecord(record["mcp_failures"]);
  const mcpFailures: { name: string; error: string }[] = [];
  if (failuresRecord !== null) {
    for (const [key, error] of Object.entries(failuresRecord)) {
      const name = asString(key);
      const text = asString(error);
      if (name !== null && text !== null) {
        mcpFailures.push({ name, error: text });
      }
    }
    mcpFailures.sort((left, right) => left.name.localeCompare(right.name));
  }
  const skillSources = countEntries(record["skill_sources"]);
  return {
    modelName: model === null ? null : asString(model["name"]),
    modelProvider: model === null ? null : asString(model["provider"]),
    mcpServers:
      mcpTools === null
        ? []
        : mcpTools.map((entry) => ({
            name: entry.name,
            toolCount: entry.count,
          })),
    mcpFailures,
    skillSources:
      skillSources === null
        ? []
        : skillSources.map((entry) => ({
            source: entry.name,
            count: entry.count,
          })),
  };
}

/**
 * 合并一次 runtime 更新（partial 语义：字段存在才覆盖；undefined 不清旧值）。
 */
function mergeRuntime(
  current: RuntimeSnapshot,
  incoming: ChrysRuntime,
): RuntimeSnapshot {
  const next: {
    -readonly [K in keyof RuntimeSnapshot]: RuntimeSnapshot[K];
  } = { ...current };
  if (typeof incoming.agentProfile === "string") {
    next.agentProfile = incoming.agentProfile;
  }
  if (typeof incoming.displayName === "string") {
    next.displayName = incoming.displayName;
  }
  if (incoming.modelProfileId !== undefined) {
    next.modelProfileId = incoming.modelProfileId;
  }
  if (incoming.maxContextTokens !== undefined) {
    next.maxContextTokens = incoming.maxContextTokens;
  }
  const toolNames = asStringList(incoming.toolNames);
  if (toolNames !== null) {
    next.toolNames = toolNames;
  }
  const skillNames = asStringList(incoming.skillNames);
  if (skillNames !== null) {
    next.skillNames = skillNames;
  }
  if (incoming.runtimeDetails !== undefined) {
    const details = parseRuntimeDetails(incoming.runtimeDetails);
    next.modelName = details.modelName;
    next.modelProvider = details.modelProvider;
    next.mcpServers = details.mcpServers;
    next.mcpFailures = details.mcpFailures;
    next.skillSources = details.skillSources;
  }
  return next;
}

/** 主 agent 用量判定：无 usageSourceId（旧版）或等于当前会话 id。 */
function isMainAgentUsage(
  usage: ChrysUsageUpdateParams,
  sessionId: string | null,
): boolean {
  if (usage.usageSourceId === undefined) {
    return true;
  }
  return sessionId !== null && usage.usageSourceId === sessionId;
}

function pickUsage(usage: ChrysUsageUpdateParams): UsageSnapshot {
  return {
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

export const createRuntimeStatusStore = () => {
  const runningToolIds = new Set<string>();
  return create<RuntimeStatusState>()((set) => ({
    ...initialState,
    handleSessionEvent: (event) => {
      switch (event.type) {
        case "chrys_runtime": {
          set((state) => ({
            lastSessionId: event.sessionId,
            runtime: mergeRuntime(state.runtime, event.runtime),
          }));
          return;
        }
        case "chrys_usage": {
          set((state) => ({
            lastSessionId: event.sessionId,
            usage: isMainAgentUsage(event.usage, event.sessionId)
              ? pickUsage(event.usage)
              : state.usage,
          }));
          return;
        }
        case "tool_call":
        case "tool_call_update": {
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
