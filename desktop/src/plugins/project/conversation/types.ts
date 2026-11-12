import type { TurnUsage } from "./turnUsage.ts";
import type {
  ContentBlock,
  ModelInfo,
  PlanEntry,
  SessionMode,
  StopReason,
  ToolCallStatus,
  ToolKind,
} from "../../../contracts/acp/protocol.ts";
import type { EditPayload } from "../../acpRuntime/types.ts";
import type { SessionSummary } from "../sessions/indexTypes.ts";
import type { SubagentToolPresentation } from "../../acpRuntime/types.ts";
import type { ToolLocation } from "../../../contracts/acp/toolLocations.ts";

export type QueuedPrompt =
  | string
  | {
      readonly id?: string;
      readonly text: string;
      readonly attachments: readonly ContentBlock[];
    };

// ---------------------------------------------------------------------------
// 会话条目
// ---------------------------------------------------------------------------

export interface UserMessageItem {
  readonly turnUsage?: TurnUsage;
  readonly attachments?: readonly unknown[];
  readonly kind: "user";
  readonly stopped?: true;
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/** 助手消息：text 为累计的 Markdown 源文本。 */
export interface AssistantMessageItem {
  readonly attachments?: readonly unknown[];
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  readonly isStreaming: boolean;
  /** 落笔时刻（ISO 8601；旧快照恢复的条目为空串，hover 时间戳不显示）。 */
  readonly createdAt: string;
}

/** 思考过程（agent_thought_chunk），默认折叠呈现。 */
export interface ThoughtItem {
  readonly attachments?: readonly unknown[];
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
  readonly locations?: readonly ToolLocation[];
  readonly toolName?: string;
  readonly subagent?: SubagentToolPresentation | null;
  readonly edit?: EditPayload;
  readonly kind: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: ToolKind | null;
  readonly status: ToolCallStatus | null;
  readonly rawInput: unknown;
  /** Adapter-supplied display text; null clears the fallback. Never protocol input. */
  readonly inputFallback?: string | null;
  readonly rawOutput: unknown;
  /** Preserve existing ACP evidence for typed tool renderers and history replay. */
  readonly content?: unknown;
  readonly _meta?: Readonly<Record<string, unknown>>;
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

export interface ConversationValues {
  readonly hasCumulativePromptUsage?: boolean;
  readonly agentKey?: string;
  readonly supportsImages?: boolean;
  readonly recovery: {
    readonly state: "idle" | "reconnecting" | "failed" | "stopped";
    readonly attempt: number;
    readonly reason: string;
  };
  readonly connectionFailure: string | null;
  /** 会话条目（含流式中的条目；plan 步骤清单也是流内条目之一）。 */
  readonly items: readonly SessionItem[];
  /** agent 是否正在处理一轮 prompt。 */
  readonly isAgentRunning: boolean;
  readonly turnState: TurnState;
  readonly isWaitingForActivity: boolean;
  readonly isAwaitingUser: boolean;
  /**
   * 运行中「稍后发送」的排队消息，随所属会话保留。
   * 出队策略：未暂停时正常结束自动发下一条；点击停止立即暂停，即使
   * 本轮抢先正常完成也不续发。取消/出错同样暂停，等待用户手动继续。
   */
  readonly queuedPrompts: readonly QueuedPrompt[];
  /** 点击停止或取消/出错后挂起；true 时等待用户 resumeQueue。 */
  readonly queueSaveError?: string | null;
  readonly queuePaused: boolean;
  /** 最近一轮的 stopReason（请求失败时为 null）。 */
  readonly lastStopReason: StopReason | null;
  /** 当前模型的展示标识。 */
  readonly modelLabel: string | null;
  /** 会话提供的可用模型清单。 */
  readonly availableModels: readonly ModelInfo[];
  /** 当前模型 id（输入行模型切换器的选中态；未知为 null）。 */
  readonly currentModelId: string | null;
  readonly pendingModelId: string | null;
  readonly availableModes: readonly SessionMode[];
  readonly pendingModeId: string | null;
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
  readonly operationsBlocked: boolean;
  /** 独立的新会话草稿视图：可编辑，连接就绪前不可发送。 */
  readonly isDraftPreparing: boolean;
  /** 最近一次发送被拒的原因（绑定缺失等；成功发送即清除）。 */
  readonly lastError: string | null;
  /** 最近一轮失败（分类供错误卡呈现「重试 / 检查设置」）。 */
  readonly turnError: {
    readonly category: "auth" | "timeout" | "generic";
    readonly message: string;
  } | null;
  /** agent 进程意外退出（非用户主动关闭）；崩溃卡数据源。 */
  readonly agentCrashed: { readonly reason: string } | null;
  /**
   * 乐观打开中的会话 id：点击瞬间就高亮目标行（树上的即时回响），
   * 连接 / 加载完成后才落 activeSessionId；失败由 endOpenSession 清除。
   */
  readonly openingSessionId: string | null;
}

export interface ConversationViewState extends ConversationValues {
  /**
   * 手动重命名会话（本机覆盖层，不回写 agent）：空字符串 / 全空白 =
   * 清除手动名，恢复跟随 ACP 原生名。
   */
  readonly renameSession: (sessionId: string, title: string) => void | Promise<void>;
  readonly refreshSessionTitle: (sessionId: string) => void;
  /** 清除轮次错误卡（重试成功 / 用户关闭卡）。 */
  readonly clearTurnError: () => void;
  /** 打开（聚焦）一个会话：切换中间区为会话视图。 */
  readonly openSession: (id: string) => void;
  /** 标记一个会话进入「打开中」（重复调用以最后一次为准）。 */
  readonly beginOpenSession: (id: string) => void;
  /** 打开流程收口：成功 / 失败都清标记（仅当仍指向该 id）。 */
  readonly endOpenSession: (id: string) => void;
  /** 清空会话条目与轮次状态（元信息保留）。 */
  readonly clear: () => void;
  readonly setLastError: (reason: string | null) => void;
}
