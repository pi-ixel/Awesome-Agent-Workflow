import type { ServerRequestHandler } from "./acpConnection.ts";
import type {
  AgentCommandEntry,
  ContentBlock,
  InitializeResult,
  ListSessionsResult,
  LoadSessionResult,
  NewSessionResult,
  PermissionOption,
  PlanEntry,
  PromptResult,
  RequestPermissionOutcome,
  ToolCallStatus,
  ToolKind,
} from "./acpProtocol.ts";
import type { AgentUsageReport } from "./agentUsage.ts";
import type { EditPayload } from "./editPayload.ts";
import type { ElicitationForm, FormResponse } from "./elicitation.ts";
import type { RuntimeSnapshot } from "./runtimeSnapshot.ts";
import type { SessionConfigOption } from "./sessionConfiguration.ts";
import type { SubagentToolPresentation } from "./subagentTool.ts";
import type { ToolLocation } from "../shared/acp/toolLocations.ts";

// ---------------------------------------------------------------------------
// 类型化事件
// ---------------------------------------------------------------------------

/** session 层派发的全部事件（判别字段 `type`）。 */
export type AcpSessionEvent =
  | {
      readonly type: "config_options";
      readonly sessionId: string;
      readonly configOptions: readonly SessionConfigOption[];
    }
  | {
      readonly type:
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      readonly sessionId: string;
      /** 宽容抽取的文本（由运行时从内容块提取）。 */
      readonly text: string;
      readonly content?: unknown;
      readonly messageId?: string;
    }
  | {
      readonly type: "tool_call" | "tool_call_update";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly title?: string;
      readonly toolName?: string;
      readonly locations?: readonly ToolLocation[];
      readonly kind?: ToolKind;
      readonly status?: ToolCallStatus;
      readonly subagent?: SubagentToolPresentation | null;
      readonly edit?: EditPayload;
      readonly rawInput?: unknown;
      /** Adapter-supplied display text; null clears the fallback. Never protocol input. */
      readonly inputFallback?: string | null;
      /** Existing top-level tool cards now represented inside this tool. */
      readonly absorbedToolCallIds?: readonly string[];
      readonly rawOutput?: unknown;
      readonly content?: unknown;
      readonly _meta?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "plan";
      readonly sessionId: string;
      readonly entries: readonly PlanEntry[];
    }
  | {
      readonly type: "usage_update";
      readonly sessionId: string;
      readonly contextSize: number | null;
      readonly contextUsed: number | null;
    }
  | {
      /** agent 侧斜杠命令清单（available_commands_update，含命名空间风格）。 */
      readonly type: "available_commands";
      readonly sessionId: string;
      readonly commands: readonly AgentCommandEntry[];
    }
  | {
      readonly type: "session_info_update";
      readonly sessionId: string;
      readonly title: string | null;
      readonly updatedAt?: string;
    }
  | {
      readonly type: "current_mode_update";
      readonly sessionId: string;
      readonly modeId: string;
      readonly name?: string;
    }
  | {
      readonly type: "agent_runtime";
      readonly sessionId: string;
      readonly runtime: Partial<RuntimeSnapshot>;
    }
  | {
      readonly type: "agent_usage";
      readonly sessionId: string;
      readonly usage: AgentUsageReport;
    }
  | {
      readonly type: "agent_error";
      readonly origin?: string;
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
      readonly recoverable: boolean | null;
    }
  | {
      readonly type: "agent_warning";
      readonly origin?: string;
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
    }
  | {
      /** 未转换为通用事件的已识别扩展通知原样透传。 */
      readonly type: "agent_extension";
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      /** 未识别的 session/update 变体或其他通知：原样透传，不丢数据。 */
      readonly type: "unknown_notification";
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    };

// ---------------------------------------------------------------------------
// 回调接口（反向请求）
// ---------------------------------------------------------------------------

/** 权限审批回调：返回决策。 */
export type PermissionResponder = (
  sessionId: string,
  toolCall: Readonly<Record<string, unknown>>,
  options: readonly PermissionOption[],
) => Promise<RequestPermissionOutcome>;

/**
 * agent 方言挂接点（扩展第二种 agent 的唯一协议层入口）：把「该 agent
 * 私有通知的翻译 / 私有反向请求的处理」从 session 硬编码搬为可注入项。
 * 标准变体的翻译与未知消息的兜底透传（unknown_notification / -32601）
 * 仍由本层负责。由 Agent 适配注册层构造（见 registry.ts 的
 * `createDialect`）。
 */
export interface AcpDialect {
  readonly normalizeConfigOptions?: (raw: unknown) => unknown;
  readonly requireConfigurationConfirmation?: boolean;
  readonly normalizeServerRequest?: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly enhanceEvent?: (event: AcpSessionEvent) => AcpSessionEvent;
  /** Extra normalized events derived by an enhancement; raw tool evidence is retained. */
  readonly deriveEvents?: (
    event: AcpSessionEvent,
  ) => readonly AcpSessionEvent[];
  /** Agents without pushed session info may request a bounded list snapshot after prompts. */
  readonly refreshSessionInfoAfterPrompt?: boolean;
  readonly normalizePermissionOutcome?: (
    outcome: RequestPermissionOutcome,
    params: Readonly<Record<string, unknown>>,
  ) => RequestPermissionOutcome;
  /**
   * 私有通知翻译：返回非 null 事件表示该通知已被方言认领；返回 null
   * 交回协议层继续（标准翻译 → unknown_notification 兜底）。
   */
  readonly translateNotification?: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => AcpSessionEvent | null;
  /**
   * 私有反向请求处理器（按 method 精确匹配）。未命中的方法交回协议层
   * （标准 ACP 反向请求或 -32601 method not found）。
   */
  readonly serverRequestHandlers?: ReadonlyMap<string, ServerRequestHandler>;
}

export interface AcpSessionOptions {
  /** Cancellation escalates to the connection owner; this channel never terminates a process. */
  readonly onCancellationTimeout?: () => Promise<unknown>;
  readonly cancellationGraceMs?: number;
  readonly onElicitation?: (
    form: ElicitationForm,
    signal: AbortSignal,
    scopeMethod?: string,
  ) => Promise<FormResponse>;
  readonly requestTimeoutMs?: number;
  readonly onConnectionFailure?: (reason: string) => void;
  /** 权限审批回调（标准 ACP `session/request_permission`）；缺省自动取消（安全默认）。 */
  readonly onPermissionRequest?: PermissionResponder;
  /** agent 方言挂接（私有通知翻译 + 私有反向请求）；纯标准 ACP agent 可省略。 */
  readonly dialect?: AcpDialect;
  /** 客户端标识（initialize 握手用）。 */
  readonly clientInfo?: { readonly name: string; readonly version?: string };
}

export type ChannelSessionOptions = AcpSessionOptions & {
  readonly background?: boolean;
};

type SessionRequestOptions = { readonly timeoutMs?: number };

/** One normalized ACP session. The runtime owns the underlying channel. */
export interface AcpSessionPort {
  readonly sessionId: string | null;
  readonly configOptions: readonly SessionConfigOption[];
  readonly models: NewSessionResult["models"];
  readonly modes: NewSessionResult["modes"];
  readonly isInitialized: boolean;
  readonly agentInfo: InitializeResult | null;
  invalidateConnection(): void;
  closeSession(): Promise<void>;
  onEvent(listener: (event: AcpSessionEvent) => void): () => void;
  initialize(options?: SessionRequestOptions): Promise<InitializeResult>;
  newSession(cwd: string, options?: SessionRequestOptions): Promise<NewSessionResult>;
  loadSession(
    sessionId: string,
    cwd: string,
    options?: SessionRequestOptions,
  ): Promise<LoadSessionResult>;
  listSessions(
    cwd?: string,
    options?: SessionRequestOptions & { readonly cursor?: string },
  ): Promise<ListSessionsResult>;
  prompt(
    text: string | readonly ContentBlock[],
    options?: SessionRequestOptions,
  ): Promise<PromptResult>;
  cancel(): void;
  setMode(modeId: string, options?: SessionRequestOptions): Promise<void>;
  setModel(modelId: string, options?: SessionRequestOptions): Promise<void>;
  setConfigOption(configId: string, value: string, options?: SessionRequestOptions): Promise<void>;
}
