import { createStoreView } from "./storeView.ts";
/**
 * 会话视图 store：把 src/acp 的类型化事件流（AcpSessionEvent）折叠为
 * 可渲染的会话条目（用户 / 助手 / 思考 / 工具调用 / 系统提示）。
 *
 * 数据流（对照 docs/architecture.md）：
 * - 上行：AcpSession.onEvent → handleEvent（本 store 的唯一事件入口）；
 * - 下行：sendPrompt 经绑定的 SessionBinding 发起 session/prompt，
 *   requestCancel 发 session/cancel 通知；
 * - 轮次生命周期：beginTurn / endTurn 是公开的轮次归约入口——sendPrompt
 *   走它们落笔用户消息与收尾，其他调用方（测试、未来的会话回放）同路。
 *
 * 折叠规则（对照 skill-eval 参考实现 session.py 的通知处理）：
 * - agent_message_chunk / agent_thought_chunk 增量拼接为一条流式条目，
 *   出现异类事件（工具调用 / 新轮次）即封口；
 * - tool_call / tool_call_update 按 toolCallId 合并为一张卡片，
 *   update 缺省的字段沿用 tool_call 落笔时的值（title 记忆）；
 * - chrys_error / chrys_warning 落为系统提示条目；
 * - 实时 user_message_chunk 忽略，用户消息由 sendPrompt 落笔避免双写；
 *   session/load 历史回放期间只接收目标会话的用户消息。
 */
import { create } from "zustand";
import { createLogger } from "../core/logger.ts";
import {
  AcpClosedError,
  AcpTimeoutError,
  AcpWriteError,
} from "../acp/errors.ts";
import type { AcpSession, AcpSessionEvent } from "../acp/session.ts";
import type {
  ModelInfo,
  PlanEntry,
  PromptResult,
  StopReason,
  ToolCallStatus,
  ToolKind,
} from "../acp/types.ts";
import {
  displayTitleOf,
  manualTitleOf,
  setManualTitle,
} from "./sessionTitles.ts";

/** 把某会话的原生名落到列表条目：记录 nativeTitle，展示标题套手动覆盖层。 */
function applyNativeTitleToList(
  list: readonly SessionSummary[],
  sessionId: string,
  nativeTitle: string,
): readonly SessionSummary[] {
  return list.map((entry) =>
    entry.id === sessionId
      ? {
          ...entry,
          nativeTitle,
          title: displayTitleOf(sessionId, nativeTitle),
        }
      : entry,
  );
}

// ---------------------------------------------------------------------------
// 会话条目
// ---------------------------------------------------------------------------

export interface UserMessageItem {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/** 助手消息：text 为累计的 Markdown 源文本。 */
export interface AssistantMessageItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  readonly isStreaming: boolean;
  /** 落笔时刻（ISO 8601；旧快照恢复的条目为空串，hover 时间戳不显示）。 */
  readonly createdAt: string;
}

/** 思考过程（agent_thought_chunk），默认折叠呈现。 */
export interface ThoughtItem {
  readonly kind: "thought";
  readonly id: string;
  readonly text: string;
  readonly isStreaming: boolean;
  /** 流式起止时刻（折叠行的耗时展示；快照恢复的历史条目为 null）。 */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** 工具调用卡片：tool_call 与后续 tool_call_update 的合并结果。 */
export interface ToolCallItem {
  readonly kind: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: ToolKind | null;
  readonly status: ToolCallStatus | null;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  /** 折叠态一行的输入摘要（toolInputSummary 计算）。 */
  readonly inputSummary: string;
  /** 结果的一行摘要（toolResultSummary 计算）。 */
  readonly resultSummary: string;
  /** 首次落笔时刻（耗时起点；随快照持久化，恢复的历史卡仍能显示总耗时）。 */
  readonly startedAt: number | null;
  /** 终态（completed/failed）落笔时刻；运行中 / 旧快照缺省为 null。 */
  readonly endedAt: number | null;
}

export type SystemNoticeLevel = "info" | "warn" | "error";

export interface SystemNoticeItem {
  readonly kind: "system";
  readonly id: string;
  readonly level: SystemNoticeLevel;
  readonly text: string;
}

/**
 * 步骤清单（ACP plan 事件，来自 todo_write 整表替换）：流内条目——
 * 与 ZCode 同款呈现为会话记录的一部分，随消息滚动，不占停靠坞。
 */
export interface PlanItem {
  readonly kind: "plan";
  readonly id: string;
  readonly entries: readonly PlanEntry[];
  /** ACP 原始会话身份；老快照缺失时仍保留历史卡，但不用于当前会话摘要。 */
  readonly sourceSessionId?: string;
}

export type SessionItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | PlanItem
  | SystemNoticeItem;

/** 一轮 prompt 的结局（响应或失败）。 */
export interface TurnOutcome {
  readonly stopReason: StopReason | null;
  readonly errorMessage?: string;
}

/** 会话元信息补丁（绑定方在 session/new 后回填，事件流随后增量更新）。 */
export interface SessionMetaPatch {
  readonly modelLabel?: string | null;
  readonly approvalMode?: {
    readonly id: string;
    readonly name?: string | null;
  } | null;
}

/** 会话列表条目（左栏渲染单元；由组装层回填）。 */
export interface SessionSummary {
  readonly id: string;
  /** 展示标题：手动覆盖层 > 原生名（见 stores/sessionTitles）。 */
  readonly title: string;
  /** ACP 提供的原生名（手动改名时悬停可见；清除手动名后恢复跟随它）。 */
  readonly nativeTitle?: string;
  /** 最近更新时间（ISO 8601）；未知为 null。 */
  readonly updatedAt: string | null;
}

/** 下行通道：prompt / cancel 的协议调用面（由 attachSession 或调用方注入）。 */
export interface SessionBinding {
  prompt(text: string): Promise<PromptResult>;
  cancel(): void;
  /** 可选能力：列出可用模型（会话建立时的 SessionModelState）。 */
  listModels?(): Promise<readonly ModelInfo[]>;
  /** 可选能力：切换会话模型（session/set_model；成功后 runtime 更新回推）。 */
  setModel?(modelId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 审批模式与停止原因的展示文案
// ---------------------------------------------------------------------------

/** chrys 的三种审批模式（server.py _APPROVAL_MODES）的中文名。 */
const approvalModeNames: Readonly<Record<string, string>> = {
  manual: "手动审批",
  auto: "自动审批",
  bypass: "全部放行",
};

/** 非 end_turn 的停止原因补一条系统提示，让轮次结局可见。 */
const stopReasonNotices: Readonly<
  Record<Exclude<StopReason, "end_turn">, string>
> = {
  cancelled: "本轮已取消",
  max_tokens: "本轮因 token 上限提前结束",
  max_turn_requests: "本轮因轮次上限提前结束",
  refusal: "agent 拒绝了本轮请求",
};

// ---------------------------------------------------------------------------
// 工具输入 / 结果的一行摘要（移植 skill-eval wire.py 的摘要优先级）
// ---------------------------------------------------------------------------

/** 输入摘要优先取值的键（skill_name > command > path > …）。 */
const toolInputPriority: readonly string[] = [
  "skill_name",
  "command",
  "path",
  "pattern",
  "query",
  "url",
];

/** 折叠所有空白为单个空格（对齐 Python 的 `" ".join(text.split())`）。 */
function collapseWhitespace(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * 性能种子的合成 assistant 正文：标题 / 段落 / 列表 / 代码块齐备，
 * 单条约 1.5KB——体量对齐真实 agent 回复，覆盖最贵的渲染路径
 * （rehype-highlight 代码块）与不可断 token 折行。
 */
function perfSeedBody(n: number): string {
  return [
    `## 模块 ${n} 审阅结论`,
    "",
    `第 ${n} 轮合成消息：用于消息流的性能与内存基准。包含常规段落、列表与`,
    "代码块，路径如 `D:/dev/demo/src/mod.ts` 这类超长不可断 token 也在覆盖范围。",
    "",
    "验证要点：",
    "- 流式分片到达时，历史消息应零重渲（memo + 条目引用稳定）",
    "- 代码块走 rehype-highlight，是单条消息里最贵的渲染路径",
    "- 快照序列化按引用脏判跳过，条目未变更不重复落盘",
    "",
    "```ts",
    `export function mod${n}(input: readonly number[]): number {`,
    "  let total = 0;",
    "  for (const value of input) {",
    "    total += value * 2;",
    "  }",
    "  return total;",
    "}",
    "```",
    "",
    `结论：模块 ${n} 无阻塞问题，可以合并。`,
  ].join("\n");
}

/** 摘要字段值：对象序列化为 JSON，其余按类型名兜底（不用 String 兜底）。 */
function valueToSummaryText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") {
      return text;
    }
  } catch {
    // 循环引用等：落入类型名兜底
  }
  return typeof value;
}

/**
 * 工具输入的一行摘要：最多两个字段、优先取标识性键（skill_name、
 * command、path…）、跳过与标题重复的值（chrys 用 command/path 当工具
 * 标题）、单值截断 120 字符。对齐 wire.py 的 tool_input_summary。
 */
export function toolInputSummary(rawInput: unknown, title: string): string {
  if (typeof rawInput === "string") {
    const text = collapseWhitespace(rawInput);
    if (text.length === 0 || text === title) {
      return "";
    }
    return text.slice(0, 120);
  }
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    // chrys 的 rawInput 是对象（engine 的 args）或字符串；其余形状不猜
    return "";
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  const prioritized = toolInputPriority.filter((key) => key in record);
  const rest = Object.keys(record).filter(
    (key) => !toolInputPriority.includes(key),
  );
  const parts: string[] = [];
  for (const key of [...prioritized, ...rest]) {
    const text = collapseWhitespace(valueToSummaryText(record[key]));
    if (text.length === 0 || text === title) {
      continue;
    }
    parts.push(`${key}=${text.slice(0, 120)}`);
    if (parts.length >= 2) {
      break;
    }
  }
  return parts.join(" · ");
}

/**
 * 工具结果的一行摘要（截断 200 字符）。协议层事件携带 rawOutput
 * （chrys 的 bridge.py 在发 content 的同时也发 raw_output），此处对齐
 * wire.py 的 tool_result_summary 的回落口径。
 */
export function toolResultSummary(rawOutput: unknown): string {
  if (typeof rawOutput === "string") {
    return collapseWhitespace(rawOutput).slice(0, 200);
  }
  if (typeof rawOutput === "object" && rawOutput !== null) {
    return collapseWhitespace(valueToSummaryText(rawOutput)).slice(0, 200);
  }
  return "";
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export type TurnState =
  | "idle"
  | "running"
  | "cancelling"
  | "unknown"
  | "completed"
  | "cancelled"
  | "failed";

/** 无进度只提醒等待，不终止请求，也不释放轮次锁。 */
export const TURN_IDLE_NOTICE_MS = 90_000;

export interface SessionStoreState {
  /** 会话条目（含流式中的条目；plan 步骤清单也是流内条目之一）。 */
  readonly items: readonly SessionItem[];
  /** agent 是否正在处理一轮 prompt。 */
  readonly isAgentRunning: boolean;
  readonly turnState: TurnState;
  readonly isWaitingForActivity: boolean;
  readonly isAwaitingUser: boolean;
  readonly setAwaitingUser: (waiting: boolean) => void;
  /**
   * 运行中「稍后发送」的排队消息（内存态，不进快照，随所属会话保留）。
   * 出队策略：未暂停时正常结束自动发下一条；点击停止立即暂停，即使
   * 本轮抢先正常完成也不续发。取消/出错同样暂停，等待用户手动继续。
   */
  readonly queuedPrompts: readonly string[];
  /** 点击停止或取消/出错后挂起；true 时等待用户 resumeQueue。 */
  readonly queuePaused: boolean;
  /** 最近一轮的 stopReason（请求失败时为 null）。 */
  readonly lastStopReason: StopReason | null;
  /** 当前模型标识（chrys runtime 的 modelProfileId / 会话元信息）。 */
  readonly modelLabel: string | null;
  /** 可用模型清单（会话建立时 chrys 下发的 SessionModelState）。 */
  readonly availableModels: readonly ModelInfo[];
  /** 当前模型 id（输入行模型切换器的选中态；未知为 null）。 */
  readonly currentModelId: string | null;
  /** 当前审批模式。 */
  readonly approvalMode: { readonly id: string; readonly name: string } | null;
  /** 是否已绑定下行通道。 */
  readonly isBound: boolean;
  /** 会话列表（当前连接项目的渲染单元；由组装层回填）。 */
  readonly sessions: readonly SessionSummary[];
  /**
   * 各项目最近一次回填的会话列表缓存（key 为工作区路径）。断开项目后
   * 缓存保留——左栏树据此在未连接的项目下继续显示历史会话子节点
   * （点击即重连该项目并切换到该会话）。
   */
  readonly sessionsByPath: Readonly<Record<string, readonly SessionSummary[]>>;
  /** 当前打开的会话 id（非空即中间区呈会话视图；AAW 面板另有开关）。 */
  readonly activeSessionId: string | null;
  /** 正在建立 ACP 连接（spawn → initialize → 恢复/新建会话）。 */
  readonly isConnecting: boolean;
  /** 最近一次发送被拒的原因（绑定缺失等；成功发送即清除）。 */
  readonly lastError: string | null;

  /** 绑定 / 解绑下行通道（prompt 与 cancel）。 */
  readonly bindSession: (binding: SessionBinding | null) => void;
  /** 事件流入口：消费协议层类型化事件。 */
  readonly handleEvent: (event: AcpSessionEvent) => void;
  /** 指定 session/load 回放目标；回放结束或失败时传 null。 */
  readonly setHistoryReplaySession: (sessionId: string | null) => void;
  /**
   * 封口流式条目（不动轮次状态）：agent 抛出结构化提问 / 审批请求时，
   * 生成已停、在等用户——消息的「生成中…」必须落定，否则等回答期间
   * 指示器永远挂着（轮次 Promise 要等回答后才 resolve，没人封口）。
   */
  readonly sealStreamingItems: () => void;
  /** 立即提交缓冲中的流式文本（合并窗口不等待；测试 / 诊断用）。 */
  readonly flushStreamingChunks: () => void;
  /** 性能基准：向当前消息流灌入 N 轮合成条目（用户 + Markdown + 工具卡）。 */
  readonly seedPerfMessages: (turns: number) => void;
  /** 轮次开始：落笔用户消息并置运行态（sendPrompt 的归约入口）。 */
  readonly beginTurn: (text: string) => void;
  /** 轮次收尾：封口流式条目并记录结局（prompt 响应 / 取消 / 失败共用）。 */
  readonly endTurn: (outcome: TurnOutcome) => void;
  /** 回填会话元信息（模型 / 审批模式）。 */
  readonly setSessionMeta: (meta: SessionMetaPatch) => void;
  /**
   * 回填会话列表（session/list 结果，由组装层调用）。workspacePath
   * 缺省时只更新当前列表（断开场景），不动各项目的列表缓存。
   */
  readonly setSessions: (
    sessions: readonly SessionSummary[],
    workspacePath?: string,
  ) => void;
  /**
   * 手动重命名会话（本机覆盖层，不回写 agent）：空字符串 / 全空白 =
   * 清除手动名，恢复跟随 ACP 原生名。
   */
  readonly renameSession: (sessionId: string, title: string) => void;
  /**
   * 补充各项目的会话列表缓存（只填空缺的项目，不覆盖已有条目）。
   *
   * 用途：左栏树要在**未连接**的项目下也能显示历史会话，而 `session/list`
   * 必须先连上 agent 才可用。组装层于是从 agent 自己的会话索引读一次
   * （见 src/agents/chrysSessions.ts），把结果补进缓存。
   *
   * 「只填空缺」是刻意的：`session/list` 拿到的列表是该项目的权威快照
   * （含刚建的新会话），而索引缓存有节流写入，可能落后几十秒——已连接过
   * 的项目一律以 session/list 为准，缓存不得回退它。
   */
  readonly mergeSessionHistory: (
    mapping: Readonly<Record<string, readonly SessionSummary[]>>,
  ) => void;
  /** 标记 ACP 连接建立中 / 已完成（装配层打点，UI 呈加载态）。 */
  readonly setConnecting: (connecting: boolean) => void;
  /** 最近一轮失败（分类供错误卡呈现「重试 / 检查设置」）。 */
  readonly turnError: {
    readonly category: "auth" | "timeout" | "generic";
    readonly message: string;
  } | null;
  /** agent 进程意外退出（非用户主动关闭）；崩溃卡数据源。 */
  readonly agentCrashed: { readonly reason: string } | null;
  /** 写一条系统公告（装配层用：恢复失败等跨层通知）。 */
  readonly pushNotice: (level: "info" | "warn" | "error", text: string) => void;
  /** 清除轮次错误卡（重试成功 / 用户关闭卡）。 */
  readonly clearTurnError: () => void;
  /** 重发最后一条用户消息（错误卡「重试」按钮）。 */
  readonly retryLastPrompt: () => void;
  /** agent 崩溃状态写入 / 清除（连接建立即清）。 */
  readonly setAgentCrashed: (reason: string | null) => void;
  /** 打开（聚焦）一个会话：切换中间区为会话视图。 */
  readonly openSession: (id: string) => void;
  /**
   * 乐观打开中的会话 id：点击瞬间就高亮目标行（树上的即时回响），
   * 连接 / 加载完成后才落 activeSessionId；失败由 endOpenSession 清除。
   */
  readonly openingSessionId: string | null;
  /** 标记一个会话进入「打开中」（重复调用以最后一次为准）。 */
  readonly beginOpenSession: (id: string) => void;
  /** 打开流程收口：成功 / 失败都清标记（仅当仍指向该 id）。 */
  readonly endOpenSession: (id: string) => void;
  /** 关闭当前会话聚焦：清空 activeSessionId（不销毁条目流）。 */
  readonly dismissSession: () => void;
  /** 会话建立后灌入模型清单与当前选中（attachSession 调用）。 */
  readonly setSessionModels: (
    models: readonly ModelInfo[],
    currentModelId: string | null,
  ) => void;
  /** 切换会话模型（session/set_model；乐观更新，失败回滚并提示）。 */
  readonly switchModel: (modelId: string) => void;
  /** 发送一轮用户消息（无绑定时如实提示，不伪造轮次）。 */
  readonly sendPrompt: (text: string) => void;
  /** 运行中把消息加入队列（空闲时的防御路径直接发送）。 */
  readonly enqueuePrompt: (text: string) => void;
  /** 放行挂起的队列：立即发下一条并恢复正常自动出队。 */
  readonly resumeQueue: () => void;
  /** 清空队列并解除挂起。 */
  readonly clearQueue: () => void;
  /** 删除指定下标的排队消息（队列空了顺便解除挂起）。 */
  readonly removeQueuedPrompt: (index: number) => void;
  /** 请求取消当前轮（session/cancel）。 */
  readonly requestCancel: () => void;
  /**
   * 专用恢复入口：直接 set 条目流（封口流式标记），不触发任何协议副作用。
   * 用于灌回本地快照 / 切换会话失败时回滚视图。
   */
  readonly restoreItems: (items: readonly SessionItem[]) => void;
  /**
   * 灌回某工作区的本地消息快照（无快照为 no-op，不清空现有条目）。
   * 由组装层在打开工作区后调用。
   */
  readonly restoreSessionLog: (workspacePath: string) => void;
  /**
   * 设定消息快照的持久化目标工作区（null 停止持久化）。切换目标前先把
   * 旧目标的当前条目落盘；随后 endTurn 即时、handleEvent 节流地写入。
   */
  readonly setSessionLogTarget: (workspacePath: string | null) => void;
  /** 立即把当前条目流落盘到目标工作区的快照（无目标时 no-op）。 */
  readonly flushSessionLog: () => void;
  /** 清空会话条目与轮次状态（元信息保留）。 */
  readonly clear: () => void;
}

const logger = createLogger("session");

/** 条目 id 计数（模块级单调递增，保证 key 稳定）。 */
let itemSeq = 0;
function nextItemId(prefix: string): string {
  itemSeq += 1;
  return `${prefix}-${itemSeq}`;
}

// ---------------------------------------------------------------------------
// 会话消息历史的本地持久化（每个工作区一份条目快照）
//
// 目的：关闭工作区再打开时，UI 消息历史可恢复（协议层 loadSession 的
// 回放之外的第二重保险）。持久化是轻量的 localStorage 快照：
// - key：`aaw-desktop/session-log/<encodeURIComponent(workspacePath)>`；
// - 写入时机：endTurn 即时落盘；handleEvent 增量按 2s 节流落盘；
// - 条目上限 200 条（保留最新），防止长期使用后无限膨胀；
// - 恢复走专用 restore action（直接 set items，不触发任何协议副作用）。
// ---------------------------------------------------------------------------

/** 快照存储 key 前缀。 */
const SESSION_LOG_PREFIX = "aaw-desktop/session-log/";
/** 快照条目上限（保留最新 N 条）。 */
const SESSION_LOG_ITEM_LIMIT = 200;
/** 增量事件的节流落盘间隔（ms）。 */
const SESSION_LOG_THROTTLE_MS = 2000;

/**
 * 流式分片的时间片合并窗口（ms）：agent_message_chunk / agent_thought_chunk
 * 高频到达，逐条 set 会让整棵消息流跟随重提交（长会话流式期间掉帧的根因）。
 * 追加文本先进缓冲、窗口内合并为一次提交；封口 / 其他条目变更 / 快照落盘
 * 前一律先 flush，条目顺序与内容语义和逐条提交完全一致。
 */
export const CHUNK_COALESCE_MS = 120;

/** 快照持久化形状（带版本号，形状变更时升版本）。 */
interface SessionLogPayload {
  readonly version: 1;
  readonly savedAt: string;
  readonly items: readonly SessionItem[];
}

function sessionLogKey(workspacePath: string): string {
  return `${SESSION_LOG_PREFIX}${encodeURIComponent(workspacePath)}`;
}

/** 条目快照：封口流式标记并截断到上限（保留最新）。
 *  system 条目（错误 / 警告 / 取消提示）是当次动作的即时反馈，
 *  不进历史——否则每次恢复会话都会回放过期的报错，误导用户。 */
function snapshotItems(items: readonly SessionItem[]): SessionItem[] {
  return items
    .filter((item) => item.kind !== "system")
    .slice(-SESSION_LOG_ITEM_LIMIT)
    .map((item) =>
      item.kind === "assistant" || item.kind === "thought"
        ? { ...item, isStreaming: false }
        : item,
    );
}

/** 把条目快照写入 localStorage（失败仅记日志，不影响会话主流程）。 */
/** 快照持久化的条数上限：超过只保最近的条目（防 localStorage 撑爆）。 */
export const PERSIST_MAX_ITEMS = 2000;

function writeSessionLog(
  workspacePath: string,
  items: readonly SessionItem[],
): void {
  try {
    // 条数上限：超限只持久化最近的条目（消息流窗口化本来就只渲染尾部，
    // 更早的以 chrys 侧会话历史为权威来源）
    const persisted =
      items.length > PERSIST_MAX_ITEMS
        ? items.slice(items.length - PERSIST_MAX_ITEMS)
        : items;
    if (persisted !== items) {
      logger.warn("会话快照超上限，仅持久化最近条目", {
        workspacePath,
        total: items.length,
        persisted: persisted.length,
      });
    }
    const payload: SessionLogPayload = {
      version: 1,
      savedAt: new Date().toISOString(),
      items: snapshotItems(persisted),
    };
    window.localStorage.setItem(
      sessionLogKey(workspacePath),
      JSON.stringify(payload),
    );
  } catch (error) {
    logger.warn("会话消息快照写入失败", {
      workspacePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 快照恢复用的工具类型白名单（与 acp/types 的联合类型一致）。 */
const restoreToolKinds: readonly ToolKind[] = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
];
const restoreToolStatuses: readonly ToolCallStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
];

function pickWhitelisted<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T | null {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

/** 逐条校验快照条目：形状不合法的丢弃，流式标记一律封口。 */
function sanitizeRestoredItem(raw: unknown): SessionItem | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const text = typeof record["text"] === "string" ? record["text"] : "";
  switch (record["kind"]) {
    case "user":
      return {
        kind: "user",
        id,
        text,
        createdAt:
          typeof record["createdAt"] === "string" ? record["createdAt"] : "",
      };
    case "assistant":
      return {
        kind: "assistant",
        id,
        text,
        isStreaming: false,
        createdAt:
          typeof record["createdAt"] === "string" ? record["createdAt"] : "",
      };
    case "thought":
      return {
        kind: "thought",
        id,
        text,
        isStreaming: false,
        startedAt: null,
        endedAt: null,
      };
    case "tool":
      return {
        kind: "tool",
        id,
        toolCallId:
          typeof record["toolCallId"] === "string" ? record["toolCallId"] : id,
        title: typeof record["title"] === "string" ? record["title"] : id,
        toolKind: pickWhitelisted(record["toolKind"], restoreToolKinds),
        status: pickWhitelisted(record["status"], restoreToolStatuses),
        rawInput: record["rawInput"],
        rawOutput: record["rawOutput"],
        inputSummary:
          typeof record["inputSummary"] === "string"
            ? record["inputSummary"]
            : "",
        resultSummary:
          typeof record["resultSummary"] === "string"
            ? record["resultSummary"]
            : "",
        startedAt:
          typeof record["startedAt"] === "number" ? record["startedAt"] : null,
        endedAt:
          typeof record["endedAt"] === "number" ? record["endedAt"] : null,
      };
    case "plan": {
      const rawEntries = Array.isArray(record["entries"])
        ? record["entries"]
        : [];
      const entries: PlanEntry[] = [];
      for (const raw of rawEntries) {
        if (typeof raw !== "object" || raw === null) {
          continue;
        }
        const entry = raw as Readonly<Record<string, unknown>>;
        const content = entry["content"];
        const status = entry["status"];
        if (typeof content !== "string" || content.length === 0) {
          continue;
        }
        if (typeof status !== "string") {
          continue;
        }
        entries.push({
          content,
          status:
            pickWhitelisted(status, ["pending", "in_progress", "completed"]) ??
            "pending",
          priority:
            typeof entry["priority"] === "string"
              ? (entry["priority"] as PlanEntry["priority"])
              : "medium",
        });
      }
      if (entries.length === 0) {
        return null;
      }
      return {
        kind: "plan",
        id,
        entries,
        ...(typeof record["sourceSessionId"] === "string"
          ? { sourceSessionId: record["sourceSessionId"] }
          : {}),
      };
    }
    case "system":
      // 历史版本的快照曾把即时反馈（错误/警告/取消）一并存入——
      // 恢复时一律丢弃，避免过期报错随会话反复出现
      return null;
    default:
      return null;
  }
}

/** 读取某工作区的消息快照（无快照或数据损坏返回空数组）。 */
function readSessionLog(workspacePath: string): SessionItem[] {
  try {
    const raw = window.localStorage.getItem(sessionLogKey(workspacePath));
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    if (record["version"] !== 1 || !Array.isArray(record["items"])) {
      return [];
    }
    const items: SessionItem[] = [];
    for (const entry of record["items"]) {
      const item = sanitizeRestoredItem(entry);
      if (item !== null) {
        items.push(item);
      }
    }
    return items.slice(-SESSION_LOG_ITEM_LIMIT);
  } catch (error) {
    logger.warn("会话消息快照读取失败，按无历史处理", {
      workspacePath,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * 会话列表标题：取首条用户消息前 24 字符（折叠空白）；历史为空回落
 * 当前时间（HH:MM）。替代「工作区会话 · agent + UUID」的旧标题。
 */
export function sessionTitleOf(
  items: readonly SessionItem[],
  fallbackTime: Date = new Date(),
): string {
  for (const item of items) {
    if (item.kind !== "user") {
      continue;
    }
    const text = item.text.trim().replace(/\s+/g, " ");
    if (text.length > 0) {
      return `会话 · ${text.slice(0, 24)}`;
    }
  }
  const hh = String(fallbackTime.getHours()).padStart(2, "0");
  const mm = String(fallbackTime.getMinutes()).padStart(2, "0");
  return `会话 · ${hh}:${mm}`;
}

export const createSessionStore = () =>
  create<SessionStoreState>((set, get) => {
    // 流式条目的落笔位置：非响应式内部状态，仅归约逻辑使用
    let openAssistantId: string | null = null;
    let openThoughtId: string | null = null;
    let historyReplaySessionId: string | null = null;
    let openReplayUser: { messageId: string; itemId: string } | null = null;
    // 当前的下行通道绑定
    let activeBinding: SessionBinding | null = null;
    // 旧 Promise 只能收尾它所属的轮次；清空、换绑、恢复均使其失效。
    let turnGeneration = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const stopIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const noteActivity = (): void => {
      stopIdleTimer();
      if (get().isWaitingForActivity) set({ isWaitingForActivity: false });
      if (!get().isAgentRunning || get().isAwaitingUser) return;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        set({ isWaitingForActivity: true });
      }, TURN_IDLE_NOTICE_MS);
    };
    // 消息快照的持久化目标（null = 不持久化）与节流定时器
    let logTargetPath: string | null = null;
    let logFlushTimer: ReturnType<typeof setTimeout> | null = null;
    // 上次已落盘的条目引用：条目数组引用未变则跳过序列化（长会话全量
    // JSON.stringify 单次几 MB，未变更的重复落盘是纯浪费）
    let lastWrittenItems: readonly SessionItem[] | null = null;

    /** 立即落盘当前条目流（并取消挂起的节流定时器）。 */
    const flushSessionLogNow = (): void => {
      // 快照必须包含缓冲中的流式文本（否则丢最后 120ms 的内容）
      flushPendingChunks();
      if (logFlushTimer !== null) {
        clearTimeout(logFlushTimer);
        logFlushTimer = null;
      }
      if (logTargetPath === null) {
        return;
      }
      const items = get().items;
      if (items === lastWrittenItems) {
        return;
      }
      writeSessionLog(logTargetPath, items);
      lastWrittenItems = items;
    };

    /** 增量事件的节流落盘（2s 内合并为一次写入）。 */
    const scheduleSessionLogFlush = (): void => {
      if (logTargetPath === null || logFlushTimer !== null) {
        return;
      }
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        flushSessionLogNow();
      }, SESSION_LOG_THROTTLE_MS);
    };

    /** 封口所有流式条目（返回新数组），并清空落笔位置。 */
    const closeStreamingItems = (
      items: readonly SessionItem[],
    ): SessionItem[] => {
      openAssistantId = null;
      openThoughtId = null;
      openReplayUser = null;
      const endedAt = Date.now();
      return items.map((item) =>
        item.kind === "thought" && (item.isStreaming || item.endedAt === null)
          ? { ...item, isStreaming: false, endedAt: item.endedAt ?? endedAt }
          : item.kind === "assistant" && item.isStreaming
            ? { ...item, isStreaming: false }
            : item,
      );
    };

    // 流式分片缓冲（CHUNK_COALESCE_MS 窗口内合并提交）
    let pendingAssistantText = "";
    let pendingThoughtText = "";
    let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null;

    /** 把缓冲中的流式文本一次性拼进对应落笔条目（空缓冲不提交，幂等）。 */
    const flushPendingChunks = (): void => {
      if (chunkFlushTimer !== null) {
        clearTimeout(chunkFlushTimer);
        chunkFlushTimer = null;
      }
      const assistant = pendingAssistantText;
      const thought = pendingThoughtText;
      pendingAssistantText = "";
      pendingThoughtText = "";
      if (assistant === "" && thought === "") {
        return;
      }
      set((state) => ({
        items: state.items.map((item) => {
          if (
            assistant !== "" &&
            item.kind === "assistant" &&
            item.id === openAssistantId &&
            item.isStreaming
          ) {
            return { ...item, text: item.text + assistant };
          }
          if (
            thought !== "" &&
            item.kind === "thought" &&
            item.id === openThoughtId &&
            item.isStreaming
          ) {
            return { ...item, text: item.text + thought };
          }
          return item;
        }),
      }));
    };

    /** 丢弃未提交的流式缓冲（会话条目整体替换前用——不把旧会话文本拼进新流）。 */
    const dropPendingChunks = (): void => {
      if (chunkFlushTimer !== null) {
        clearTimeout(chunkFlushTimer);
        chunkFlushTimer = null;
      }
      pendingAssistantText = "";
      pendingThoughtText = "";
    };

    /** 先 flush 流式缓冲再封口（「读当前条目并封口」的统一入口）。 */
    const sealedItems = (): SessionItem[] => {
      flushPendingChunks();
      return closeStreamingItems(get().items);
    };

    const pushSystemItem = (level: SystemNoticeLevel, text: string): void => {
      const closed = sealedItems();
      set({
        items: [
          ...closed,
          { kind: "system", id: nextItemId("system"), level, text },
        ],
      });
    };

    /** 轮次失败分类：auth/timeout 错误卡带专属下一步，其余 generic。 */
    function classifyTurnError(message: string): {
      category: "auth" | "timeout" | "generic";
      message: string;
    } {
      if (
        /auth|401|403|api[_ -]?key|unauthorized|model|模型|密钥/i.test(message)
      ) {
        return { category: "auth", message };
      }
      if (/timeout|超时/i.test(message)) {
        return { category: "timeout", message };
      }
      return { category: "generic", message };
    }

    /** 取消结案卡：统计本轮已完成的写类操作，给出回退指引（闭环交代）。 */
    function buildCancelledRecap(
      turnItems: readonly SessionItem[],
    ): SystemNoticeItem {
      const done = turnItems.filter(
        (item): item is Extract<SessionItem, { kind: "tool" }> =>
          item.kind === "tool" &&
          item.status === "completed" &&
          (item.toolKind === "edit" ||
            item.toolKind === "delete" ||
            item.toolKind === "move" ||
            item.toolKind === "execute"),
      );
      if (done.length === 0) {
        return {
          kind: "system",
          id: nextItemId("system"),
          level: "warn",
          text: "本轮已取消，agent 未执行任何修改操作。",
        };
      }
      const titles = done
        .slice(0, 5)
        .map((item) => " · " + item.title)
        .join("\n");
      return {
        kind: "system",
        id: nextItemId("system"),
        level: "warn",
        text:
          "本轮已取消。期间 agent 完成了 " +
          String(done.length) +
          " 项操作：\n" +
          titles +
          "\n如需回退，可让 agent 撤销这些改动，或查看项目 git diff。",
      };
    }

    /** 本轮起点（beginTurn 时的条目数）：结案卡按此取本轮条目。 */
    let turnStartLength = 0;

    /** 落笔用户消息并标记轮次开始（轮次生命周期的真实领域入口）。 */
    const beginTurn = (text: string): void => {
      historyReplaySessionId = null;
      turnGeneration += 1;
      turnStartLength = get().items.length;
      const closed = sealedItems();
      set({
        items: [
          ...closed,
          {
            kind: "user",
            id: nextItemId("user"),
            text,
            createdAt: new Date().toISOString(),
          },
        ],
        isAgentRunning: true,
        turnState: "running",
        isAwaitingUser: false,
        turnError: null,
        lastStopReason: null,
      });
      noteActivity();
    };

    /** 轮次收尾（prompt 响应 / 取消 / 失败共用）：封口、记录结局。 */
    const endTurn = (outcome: TurnOutcome): void => {
      turnGeneration += 1;
      stopIdleTimer();
      const additions: SystemNoticeItem[] = [];
      if (outcome.errorMessage !== undefined) {
        additions.push({
          kind: "system",
          id: nextItemId("system"),
          level: "error",
          text: `本轮请求失败：${outcome.errorMessage}`,
        });
        set({ turnError: classifyTurnError(outcome.errorMessage) });
      } else if (
        outcome.stopReason !== null &&
        outcome.stopReason !== "end_turn"
      ) {
        additions.push({
          kind: "system",
          id: nextItemId("system"),
          level: outcome.stopReason === "cancelled" ? "warn" : "info",
          text: stopReasonNotices[outcome.stopReason],
        });
        set({ turnError: null });
        if (outcome.stopReason === "cancelled") {
          additions.push(
            buildCancelledRecap(get().items.slice(turnStartLength)),
          );
        }
      }
      const closed = sealedItems();
      set({
        items: additions.length > 0 ? [...closed, ...additions] : closed,
        isAgentRunning: false,
        turnState:
          outcome.errorMessage !== undefined
            ? "failed"
            : outcome.stopReason === "cancelled"
              ? "cancelled"
              : "completed",
        isWaitingForActivity: false,
        isAwaitingUser: false,
        turnError:
          outcome.errorMessage === undefined
            ? null
            : classifyTurnError(outcome.errorMessage),
        lastStopReason: outcome.stopReason,
        lastError: null,
      });
      // 点击停止时已暂停队列；本轮正常完成不能撤销用户的停止意图。
      if (get().queuedPrompts.length > 0) {
        const failed = outcome.errorMessage !== undefined;
        const cancelled = outcome.stopReason === "cancelled";
        if (failed || cancelled) {
          set({ queuePaused: true });
        } else if (!get().queuePaused) {
          drainNextQueued();
        }
      }
      // 轮次收尾即时落盘（增量部分已按节流写入，这里保证结局不丢）
      flushSessionLogNow();
    };

    /** 出队下一条排队消息（不检查挂起——调用方负责）。 */
    const drainNextQueued = (): void => {
      // 不能发送时保留队首，避免合并后的发送保护拒绝消息而队列已丢失它。
      if (
        get().isAgentRunning ||
        get().isConnecting ||
        activeBinding === null
      ) {
        set({ queuePaused: true });
        return;
      }
      const next = get().queuedPrompts[0];
      if (next === undefined) {
        return;
      }
      set({
        queuedPrompts: get().queuedPrompts.slice(1),
        queuePaused: false,
      });
      get().sendPrompt(next);
    };

    /** chunk 增量拼接：无落笔条目时新建（并封口另一种流式条目）。 */
    const appendChunk = (isThought: boolean, text: string): void => {
      const openId = isThought ? openThoughtId : openAssistantId;
      if (openId !== null) {
        // 时间片合并：首个分片已建条目即时可见，后续分片进缓冲，
        // CHUNK_COALESCE_MS 窗口内合并为一次提交（封口前必 flush）
        if (isThought) {
          pendingThoughtText += text;
        } else {
          pendingAssistantText += text;
        }
        if (chunkFlushTimer === null) {
          chunkFlushTimer = setTimeout(() => {
            chunkFlushTimer = null;
            flushPendingChunks();
          }, CHUNK_COALESCE_MS);
        }
        return;
      }
      // 换落笔目标：先把上一段的缓冲拼进旧条目再封口（顺序不可颠倒）
      const closed = sealedItems();
      const id = nextItemId(isThought ? "thought" : "assistant");
      if (isThought) {
        openThoughtId = id;
      } else {
        openAssistantId = id;
      }
      const item: ThoughtItem | AssistantMessageItem = isThought
        ? {
            kind: "thought",
            id,
            text,
            isStreaming: true,
            startedAt: Date.now(),
            endedAt: null,
          }
        : {
            kind: "assistant",
            id,
            text,
            isStreaming: true,
            createdAt: new Date().toISOString(),
          };
      set({ items: [...closed, item] });
    };

    /** tool_call / tool_call_update 按 toolCallId 合并为一张卡片。 */
    const applyToolEvent = (
      event: Extract<
        AcpSessionEvent,
        { readonly type: "tool_call" | "tool_call_update" }
      >,
    ): void => {
      // 工具事件会封口流式文本条目：先 flush 缓冲，保证文本先于工具卡落位
      const items = sealedItems();
      const index = items.findIndex(
        (item) => item.kind === "tool" && item.toolCallId === event.toolCallId,
      );
      if (index === -1) {
        const title = event.title ?? event.toolCallId;
        const status = event.status ?? null;
        const isTerminal = status === "completed" || status === "failed";
        set({
          items: [
            ...items,
            {
              kind: "tool",
              id: nextItemId("tool"),
              toolCallId: event.toolCallId,
              title,
              toolKind: event.kind ?? null,
              status,
              rawInput: event.rawInput,
              rawOutput: event.rawOutput,
              inputSummary: toolInputSummary(event.rawInput, title),
              resultSummary:
                event.rawOutput === undefined
                  ? ""
                  : toolResultSummary(event.rawOutput),
              // 落笔即带终态（chrys 偶发不送 in_progress 中间态）：起止同刻，耗时 0
              startedAt: Date.now(),
              endedAt: isTerminal ? Date.now() : null,
            },
          ],
        });
        return;
      }
      const existing = items[index];
      if (existing === undefined || existing.kind !== "tool") {
        return;
      }
      // update 缺省的字段沿用 tool_call 落笔值（对齐 Python 的 title 记忆）
      const title = event.title ?? existing.title;
      const rawInput = event.rawInput ?? existing.rawInput;
      const rawOutput = event.rawOutput ?? existing.rawOutput;
      const status = event.status ?? existing.status;
      // 首次进入终态时定格耗时；之后（重跑等）不覆盖已定格的 endedAt
      const wasTerminal =
        existing.status === "completed" || existing.status === "failed";
      const isTerminal = status === "completed" || status === "failed";
      const endedAt =
        !wasTerminal && isTerminal ? Date.now() : existing.endedAt;
      const merged: ToolCallItem = {
        ...existing,
        title,
        toolKind: event.kind ?? existing.toolKind,
        status,
        rawInput,
        rawOutput,
        inputSummary:
          event.rawInput !== undefined
            ? toolInputSummary(rawInput, title)
            : existing.inputSummary,
        resultSummary:
          event.rawOutput !== undefined
            ? toolResultSummary(rawOutput)
            : existing.resultSummary,
        startedAt: existing.startedAt,
        endedAt,
      };
      set({
        items: items.map((item, position) =>
          position === index ? merged : item,
        ),
      });
    };

    return {
      items: [],
      queuedPrompts: [],
      queuePaused: false,
      isAgentRunning: false,
      turnState: "idle",
      isWaitingForActivity: false,
      isAwaitingUser: false,
      lastStopReason: null,
      modelLabel: null,
      availableModels: [],
      currentModelId: null,
      approvalMode: null,
      isBound: false,
      sessions: [],
      sessionsByPath: {},
      activeSessionId: null,
      openingSessionId: null,
      isConnecting: false,
      turnError: null,
      agentCrashed: null,
      lastError: null,

      bindSession: (binding) => {
        if (binding !== activeBinding) {
          turnGeneration += 1;
          if (get().isAgentRunning) set({ turnState: "unknown" });
        }
        activeBinding = binding;
        set({ isBound: binding !== null });
      },

      setAwaitingUser: (waiting) => {
        const next = waiting && get().isAgentRunning;
        if (get().isAwaitingUser === next) return;
        set({ isAwaitingUser: next });
        noteActivity();
      },

      sealStreamingItems: () => {
        set({ items: sealedItems() });
      },

      /** 测试与诊断用：立即提交缓冲中的流式文本（合并窗口不等待）。 */
      flushStreamingChunks: () => {
        flushPendingChunks();
      },

      renameSession: (sessionId, title) => {
        setManualTitle(sessionId, title);
        const manual = manualTitleOf(sessionId);
        // 展示标题重算：手动 > 原生（无原生名时清除手动则保持原值）
        const retitle = (entry: SessionSummary): SessionSummary =>
          entry.id === sessionId
            ? {
                ...entry,
                title: manual ?? entry.nativeTitle ?? entry.title,
              }
            : entry;
        set((state) => ({
          sessions: state.sessions.map(retitle),
          sessionsByPath: Object.fromEntries(
            Object.entries(state.sessionsByPath).map(([path, list]) => [
              path,
              list.map(retitle),
            ]),
          ),
        }));
        logger.debug("会话手动改名", { sessionId, manual });
      },

      seedPerfMessages: (turns) => {
        dropPendingChunks();
        const now = Date.now();
        const additions: SessionItem[] = [];
        for (let n = 1; n <= turns; n += 1) {
          const at = new Date(now - (turns - n) * 60_000).toISOString();
          const stamp = `${now}-${n}`;
          additions.push({
            kind: "user",
            id: `perf-user-${stamp}`,
            text: `性能种子 ${n}：请审阅这段实现，指出可优化点并给出修改建议。`,
            createdAt: at,
          });
          additions.push({
            kind: "assistant",
            id: `perf-agent-${stamp}`,
            isStreaming: false,
            createdAt: at,
            text: perfSeedBody(n),
          });
          if (n % 3 === 0) {
            const startedAt = now - (turns - n) * 60_000;
            additions.push({
              kind: "tool",
              id: `perf-tool-${stamp}`,
              toolCallId: `perf-tool-${stamp}`,
              title: `read src/mod${n}.ts`,
              toolKind: "read",
              status: "completed",
              rawInput: { path: `src/mod${n}.ts` },
              rawOutput: `${perfSeedBody(n).length} bytes`,
              inputSummary: `path: src/mod${n}.ts`,
              resultSummary: "读取完成（合成输出）",
              startedAt,
              endedAt: startedAt + 400,
            });
          }
        }
        set({ items: [...get().items, ...additions] });
        scheduleSessionLogFlush();
        logger.info("已灌入性能种子消息", {
          turns,
          items: additions.length,
        });
      },

      setHistoryReplaySession: (sessionId) => {
        historyReplaySessionId = sessionId;
        openReplayUser = null;
      },

      handleEvent: (event) => {
        if (event.type !== "user_message_chunk") {
          openReplayUser = null;
        }
        if (
          event.type === "agent_message_chunk" ||
          event.type === "agent_thought_chunk" ||
          event.type === "tool_call" ||
          event.type === "tool_call_update" ||
          event.type === "plan" ||
          event.type === "usage_update"
        ) {
          noteActivity();
        }
        switch (event.type) {
          case "agent_message_chunk":
            appendChunk(false, event.text);
            scheduleSessionLogFlush();
            return;
          case "agent_thought_chunk":
            appendChunk(true, event.text);
            scheduleSessionLogFlush();
            return;
          case "session_info_update": {
            // ACP 推送的会话名变更（agent 侧自动总结改题）：原生名随时跟随，
            // 展示标题仍被手动覆盖层压制（手动 > 原生）
            const native = event.title?.trim() ?? "";
            if (native.length === 0) {
              return;
            }
            set((state) => ({
              sessions: applyNativeTitleToList(
                state.sessions,
                event.sessionId,
                native,
              ),
              sessionsByPath: Object.fromEntries(
                Object.entries(state.sessionsByPath).map(([path, list]) => [
                  path,
                  applyNativeTitleToList(list, event.sessionId, native),
                ]),
              ),
            }));
            return;
          }
          case "tool_call":
          case "tool_call_update":
            applyToolEvent(event);
            scheduleSessionLogFlush();
            return;
          case "user_message_chunk": {
            // 实时回显由 beginTurn 落笔，避免重复；历史回放则必须恢复原文。
            if (
              historyReplaySessionId === null ||
              event.sessionId !== historyReplaySessionId
            ) {
              return;
            }
            const items = get().items;
            const last = items[items.length - 1];
            if (
              event.messageId &&
              openReplayUser?.messageId === event.messageId &&
              last?.kind === "user" &&
              last.id === openReplayUser.itemId
            ) {
              set({
                items: [
                  ...items.slice(0, -1),
                  { ...last, text: last.text + event.text },
                ],
              });
            } else {
              // 上游会缓冲流式分片：切到用户消息前必须先提交上一条回复。
              const closed = sealedItems();
              const id = nextItemId("user");
              set({
                items: [
                  ...closed,
                  { kind: "user", id, text: event.text, createdAt: "" },
                ],
              });
              // Chrys 回放没有 messageId，每条通知代表独立提问，不能凭相邻合并。
              openReplayUser = event.messageId
                ? { messageId: event.messageId, itemId: id }
                : null;
            }
            scheduleSessionLogFlush();
            return;
          }
          case "plan": {
            // todo_write 整表替换（bridge.plan_update_for_todos）。流内呈现：
            // 更新最后一张未完结的清单卡；上一张已全部完成而新清单有活干，
            // 说明 agent 开了新任务——落一张新卡，不改写历史。
            if (event.entries.length === 0) {
              return;
            }
            const items = sealedItems();
            const lastIndex = (() => {
              for (let index = items.length - 1; index >= 0; index -= 1) {
                if (items[index]?.kind === "plan") {
                  return index;
                }
              }
              return -1;
            })();
            const last = lastIndex >= 0 ? items[lastIndex] : undefined;
            const lastAllDone =
              last !== undefined &&
              last.kind === "plan" &&
              last.entries.every((entry) => entry.status === "completed");
            if (
              last !== undefined &&
              last.kind === "plan" &&
              !lastAllDone &&
              last.sourceSessionId === event.sessionId
            ) {
              set({
                items: items.map((item, position) =>
                  position === lastIndex
                    ? {
                        ...item,
                        entries: event.entries,
                        sourceSessionId: event.sessionId,
                      }
                    : item,
                ),
              });
            } else {
              set({
                items: [
                  ...items,
                  {
                    kind: "plan",
                    id: nextItemId("plan"),
                    sourceSessionId: event.sessionId,
                    entries: event.entries,
                  },
                ],
              });
            }
            scheduleSessionLogFlush();
            return;
          }
          case "current_mode_update": {
            const name = approvalModeNames[event.modeId] ?? event.modeId;
            set({ approvalMode: { id: event.modeId, name } });
            return;
          }
          case "chrys_runtime": {
            const model = event.runtime.modelProfileId;
            if (typeof model === "string" && model.length > 0) {
              set({ modelLabel: model });
            }
            return;
          }
          case "chrys_error":
            pushSystemItem(
              "error",
              `chrys 错误${event.code === null ? "" : `（${event.code}）`}：${event.message}`,
            );
            scheduleSessionLogFlush();
            return;
          case "chrys_warning":
            pushSystemItem("warn", `chrys 警告：${event.message}`);
            scheduleSessionLogFlush();
            return;
          default:
            // usage / 扩展通知：聊天流不消费，诊断页（logStore）可见
            return;
        }
      },

      beginTurn: (text) => {
        beginTurn(text);
      },

      endTurn: (outcome) => {
        endTurn(outcome);
      },

      setSessionMeta: (meta) => {
        const patch: {
          modelLabel?: string | null;
          approvalMode?: { readonly id: string; readonly name: string } | null;
        } = {};
        if (meta.modelLabel !== undefined) {
          patch.modelLabel = meta.modelLabel;
        }
        if (meta.approvalMode !== undefined) {
          patch.approvalMode =
            meta.approvalMode === null
              ? null
              : {
                  id: meta.approvalMode.id,
                  name:
                    approvalModeNames[meta.approvalMode.id] ??
                    meta.approvalMode.name ??
                    meta.approvalMode.id,
                };
        }
        set(patch);
      },

      setConnecting: (connecting) => {
        set({ isConnecting: connecting });
      },

      pushNotice: (level, text) => {
        pushSystemItem(level, text);
      },

      clearTurnError: () => {
        set({ turnError: null });
      },

      retryLastPrompt: () => {
        if (get().isAgentRunning) {
          return;
        }
        const lastUser = [...get().items]
          .reverse()
          .find((item) => item.kind === "user");
        if (lastUser !== undefined) {
          get().sendPrompt(lastUser.text);
        }
      },

      setAgentCrashed: (reason) => {
        set({ agentCrashed: reason === null ? null : { reason } });
        if (reason !== null) {
          activeBinding = null;
          set({ isBound: false });
          if (get().isAgentRunning)
            endTurn({ stopReason: null, errorMessage: reason });
        }
      },

      setSessions: (sessions, workspacePath) => {
        // 入口即套手动覆盖层：title = 手动 > 原生；原生名留在 nativeTitle
        const blended = sessions.map((entry) => ({
          ...entry,
          nativeTitle: entry.title,
          title: displayTitleOf(entry.id, entry.title),
        }));
        set((state) => ({
          sessions: blended,
          // 带路径的回填同步进各项目的列表缓存（树的历史会话子节点数据源）
          ...(workspacePath === undefined
            ? {}
            : {
                sessionsByPath: {
                  ...state.sessionsByPath,
                  [workspacePath]: blended,
                },
              }),
          // 聚焦的会话不在新列表里时回落首项（无会话则回向导）
          activeSessionId:
            state.activeSessionId === null
              ? (blended[0]?.id ?? null)
              : blended.some((entry) => entry.id === state.activeSessionId)
                ? state.activeSessionId
                : (blended[0]?.id ?? null),
        }));
      },

      mergeSessionHistory: (mapping) => {
        set((state) => {
          const entries = Object.entries(mapping);
          if (entries.length === 0) {
            return {};
          }
          let changed = false;
          const next = { ...state.sessionsByPath };
          for (const [path, sessions] of entries) {
            if (sessions.length === 0) {
              continue;
            }
            // 已有条目（session/list 回填过，或上一次已补充）一律不动
            if (next[path] !== undefined) {
              continue;
            }
            // 磁盘兜底列表同样套手动覆盖层（手动改过名的旧会话树里也该显示手动名）
            next[path] = sessions.map((entry) => ({
              ...entry,
              nativeTitle: entry.title,
              title: displayTitleOf(entry.id, entry.title),
            }));
            changed = true;
          }
          return changed ? { sessionsByPath: next } : {};
        });
      },

      openSession: (id) => {
        if (!get().sessions.some((entry) => entry.id === id)) {
          return;
        }
        set({ activeSessionId: id });
        logger.debug("会话已聚焦", { id });
      },

      beginOpenSession: (id) => {
        set({ openingSessionId: id });
      },

      endOpenSession: (id) => {
        if (get().openingSessionId === id) {
          set({ openingSessionId: null });
        }
      },

      dismissSession: () => {
        set({ activeSessionId: null });
      },

      sendPrompt: (text) => {
        const trimmed = text.trim();
        if (
          trimmed.length === 0 ||
          get().isAgentRunning ||
          get().isConnecting
        ) {
          return;
        }
        const binding = activeBinding;
        if (binding === null) {
          const message =
            "尚未连接 agent，消息未发送——请先在项目总览点「新建会话」建立连接";
          pushSystemItem("error", message);
          // 结构化失败原因：向导提交等调用方据此向用户展示（不只落消息流）
          set({ lastError: message });
          return;
        }
        set({ lastError: null });
        beginTurn(trimmed);
        set({ turnError: null });
        logger.info("用户消息已发送", { length: trimmed.length });
        const generation = turnGeneration;
        const isCurrent = (): boolean =>
          generation === turnGeneration && binding === activeBinding;
        const onFailure = (error: unknown): void => {
          if (!isCurrent()) return;
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("本轮 prompt 失败", { reason: message });
          if (
            error instanceof AcpTimeoutError ||
            error instanceof AcpWriteError
          ) {
            // 等待失败不能证明远端已停止，保持锁定，避免重复执行。
            set({ turnState: "unknown", lastError: message });
            return;
          }
          if (error instanceof AcpClosedError) {
            activeBinding = null;
            set({ isBound: false, agentCrashed: { reason: message } });
          }
          endTurn({ stopReason: null, errorMessage: message });
        };
        try {
          void binding.prompt(trimmed).then((result) => {
            if (isCurrent()) endTurn({ stopReason: result.stopReason });
          }, onFailure);
        } catch (error) {
          onFailure(error);
        }
      },

      setSessionModels: (models, currentModelId) => {
        set({ availableModels: models, currentModelId });
      },

      switchModel: (modelId) => {
        const binding = activeBinding;
        if (binding === null || binding.setModel === undefined) {
          pushSystemItem("warn", "当前会话不支持切换模型");
          return;
        }
        const previous = get().currentModelId;
        set({ currentModelId: modelId });
        logger.info("切换会话模型", { modelId });
        void binding.setModel(modelId).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("模型切换失败，回滚", { modelId, reason: message });
          set({ currentModelId: previous });
          pushSystemItem("error", `模型切换失败：${message}`);
        });
      },

      enqueuePrompt: (text) => {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          return;
        }
        if (!get().isAgentRunning) {
          // 空闲态不该走到这（UI 只在运行中入队）：按直接发送兜底
          get().sendPrompt(trimmed);
          return;
        }
        set({ queuedPrompts: [...get().queuedPrompts, trimmed] });
        logger.info("消息已加入队列", { depth: get().queuedPrompts.length });
      },

      resumeQueue: () => {
        if (get().queuedPrompts.length === 0) {
          set({ queuePaused: false });
          return;
        }
        if (get().isAgentRunning) {
          // 正在跑：只解除挂起，本轮结束由 endTurn 自动出队
          set({ queuePaused: false });
          return;
        }
        drainNextQueued();
      },

      clearQueue: () => {
        set({ queuedPrompts: [], queuePaused: false });
      },

      removeQueuedPrompt: (index) => {
        const current = get().queuedPrompts;
        if (index < 0 || index >= current.length) {
          return;
        }
        const next = current.filter((_, position) => position !== index);
        set({
          queuedPrompts: next,
          queuePaused: next.length === 0 ? false : get().queuePaused,
        });
      },

      requestCancel: () => {
        if (!get().isAgentRunning || get().turnState === "cancelling") {
          return;
        }
        // 先记录停止意图，再发通知；即使当前没有排队消息，随后入队的也等待放行。
        set({ queuePaused: true });
        const binding = activeBinding;
        if (binding === null) {
          set({ turnState: "unknown" });
          return;
        }
        set({ turnState: "cancelling" });
        noteActivity();
        try {
          binding.cancel();
          logger.info("已请求取消当前轮（session/cancel）");
        } catch (error) {
          set({
            turnState: "unknown",
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      },

      clear: () => {
        turnGeneration += 1;
        stopIdleTimer();
        historyReplaySessionId = null;
        openReplayUser = null;
        // 会话清空时流式落笔锚点一并复位，否则后续 chunk 会拼到已消失的条目上
        openAssistantId = null;
        openThoughtId = null;
        // 取消挂起的节流落盘：clear 后条目为空，此时落盘会用空快照覆盖历史
        if (logFlushTimer !== null) {
          clearTimeout(logFlushTimer);
          logFlushTimer = null;
        }
        set({
          items: [],
          queuedPrompts: [],
          queuePaused: false,
          isAgentRunning: false,
          turnState: "idle",
          isWaitingForActivity: false,
          isAwaitingUser: false,
          turnError: null,
          lastStopReason: null,
          lastError: null,
          openingSessionId: null,
        });
      },

      restoreItems: (items) => {
        turnGeneration += 1;
        stopIdleTimer();
        historyReplaySessionId = null;
        openReplayUser = null;
        openAssistantId = null;
        openThoughtId = null;
        set({
          items: snapshotItems(items),
          queuedPrompts: [],
          queuePaused: false,
          isAgentRunning: false,
          turnState: "idle",
          isWaitingForActivity: false,
          isAwaitingUser: false,
          turnError: null,
          lastStopReason: null,
        });
      },

      restoreSessionLog: (workspacePath) => {
        // 会话条目即将整体替换：旧会话的未提交流式缓冲一并丢弃
        dropPendingChunks();
        const restored = readSessionLog(workspacePath);
        if (restored.length === 0) {
          return;
        }
        get().restoreItems(restored);
        logger.info("已灌回本地消息快照", {
          workspacePath,
          count: restored.length,
        });
      },

      setSessionLogTarget: (workspacePath) => {
        if (workspacePath === logTargetPath) {
          return;
        }
        // 切换前以旧目标收口落盘（flushSessionLogNow 读的是旧目标）
        flushSessionLogNow();
        logTargetPath = workspacePath;
        // 新目标的首写不受「引用未变跳过」约束（旧键的落盘记录不代表新键）
        lastWrittenItems = null;
      },

      flushSessionLog: () => {
        flushSessionLogNow();
      },
    };
  });

const sessionView = createStoreView(createSessionStore());
export const useSessionStore = sessionView.view;
export const selectSessionStore = sessionView.select;
export type SessionStore = ReturnType<typeof createSessionStore>;

// ---------------------------------------------------------------------------
// 协议会话挂接（真实通路的一行式组装）
// ---------------------------------------------------------------------------

/**
 * 把 AcpSession 挂接到会话视图 store：事件流接 handleEvent，下行通道
 * （prompt / cancel）绑定为 session 的协议方法。返回解挂函数。
 *
 * 每条 ACP 连接绑定自己的 store；切换视图不会解除后台连接的事件订阅。
 */
export function attachSession(
  acp: AcpSession,
  store = useSessionStore,
): () => void {
  const unsubscribe = acp.onEvent((event) => {
    store.getState().handleEvent(event);
  });
  store.getState().bindSession({
    prompt: (text) => acp.prompt(text),
    cancel: () => acp.cancel(),
    listModels: () => Promise.resolve(acp.models?.availableModels ?? []),
    setModel: (modelId) => acp.setModel(modelId),
  });
  // 会话建立时的模型清单与当前选中一并灌入（输入行切换器数据源）
  store
    .getState()
    .setSessionModels(
      acp.models?.availableModels ?? [],
      acp.models?.currentModelId ?? null,
    );
  logger.info("会话视图已挂接 ACP 会话");
  return () => {
    unsubscribe();
    store.getState().bindSession(null);
  };
}
