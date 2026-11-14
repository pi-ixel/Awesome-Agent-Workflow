/**
 * ACP wire methods and data shapes used by the Desktop client.
 * Private wire payloads belong to the Agent enhancements.
 * Incoming JSON is narrowed from unknown; unknown notifications remain available.
 */

// ---------------------------------------------------------------------------
// 基础共用类型
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 消息 id（ACP 实践中为数字或字符串）。 */
export type JsonRpcId = number | string;

/** JSON 值的最小闭环描述（wire 数据以 unknown 进入，此处仅用于构造出站消息）。 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-RPC 错误对象（响应中的 error 字段）。 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 线上方法名全集（客户端→agent 与 agent→client）。 */
export const ACP_METHOD = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionClose: "session/close",
  /** agent→client 请求：权限审批。 */
  sessionRequestPermission: "session/request_permission",
  /** agent→client 通知：会话更新流。 */
  sessionUpdate: "session/update",
} as const;

/** 客户端支持的最新协议版本。 */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// content block（prompt 与 chunk 共用）
// ---------------------------------------------------------------------------

/** 文本内容块。 */
export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

/** 允许原样转发其他内容块。 */
export type ContentBlock =
  TextContentBlock | { readonly type: string; readonly [key: string]: unknown };

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface FsCapabilities {
  readonly readTextFile: boolean;
  readonly writeTextFile: boolean;
}

export interface ClientCapabilities {
  readonly fs: FsCapabilities;
}

export interface Implementation {
  readonly name: string;
  readonly version?: string;
}

export interface InitializeRequestParams {
  readonly protocolVersion: number;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo: Implementation;
  /** 能力声明保留原始字段，由调用方检查需要的能力。 */
  readonly agentCapabilities: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// session/new | load | list
// ---------------------------------------------------------------------------

/** 名值对（ACP EnvVariable / HttpHeader 同形）。 */
export interface McpNameValue {
  readonly name: string;
  readonly value: string;
}

/**
 * ACP 会话中提供的 stdio MCP server 配置（规范基线传输，所有 Agent 必须
 * 支持）。线格式与 ACP schema 逐字段一致：**没有 type 判别字段**，args 与
 * env 必填，env 是名值对列表（不是对象）。
 */
export interface McpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly McpNameValue[];
}

/** ACP HTTP MCP 服务及其请求头。 */
export interface McpServerHttp {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: readonly McpNameValue[];
}

export type McpServer = McpServerStdio | McpServerHttp;

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** 会话模式及其当前选项。 */
export interface SessionModeState {
  readonly currentModeId: string;
  readonly availableModes: readonly SessionMode[];
}

export interface ModelInfo {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface SessionModelState {
  readonly currentModelId: string | null;
  readonly availableModels: readonly ModelInfo[];
}

export interface NewSessionRequestParams {
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  readonly additionalDirectories?: readonly string[];
}

export interface NewSessionResult {
  readonly sessionId: string;
  readonly modes?: SessionModeState | null;
  readonly models?: SessionModelState | null;
}

export interface LoadSessionRequestParams {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  readonly additionalDirectories?: readonly string[];
}

export interface LoadSessionResult {
  readonly modes?: SessionModeState | null;
  readonly models?: SessionModelState | null;
}

/** session/list 返回的会话摘要。 */
export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly additionalDirectories?: readonly string[];
  readonly title?: string | null;
  /** ISO 8601 时间戳。 */
  readonly updatedAt?: string | null;
}

export interface ListSessionsRequestParams {
  readonly cwd?: string;
  readonly cursor?: string;
  readonly additionalDirectories?: readonly string[];
}

export interface ListSessionsResult {
  readonly sessions: readonly SessionInfo[];
  readonly nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// session/prompt | cancel | set_mode | set_model | close
// ---------------------------------------------------------------------------

export interface PromptRequestParams {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
  /** 客户端侧消息 id（回显在响应的 userMessageId）。 */
  readonly messageId?: string;
}

/** Prompt 结束原因。 */
export type StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** Prompt 响应附带的用量字段。 */
export interface PromptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedReadTokens?: number;
}

export interface PromptResult {
  readonly modelId?: string;
  readonly stopReason: StopReason;
  readonly usage?: PromptUsage | null;
  readonly userMessageId?: string | null;
}

export interface CancelNotificationParams {
  readonly sessionId: string;
}

export interface SetModeRequestParams {
  readonly sessionId: string;
  readonly modeId: string;
}

export interface SetModelRequestParams {
  readonly sessionId: string;
  readonly modelId: string;
}

export interface CloseSessionRequestParams {
  readonly sessionId: string;
}

/** 空响应（set_mode / set_model / close 等成功即无字段）。 */
export type EmptyResult = Record<string, never>;

// ---------------------------------------------------------------------------
// session/update 通知
// ---------------------------------------------------------------------------

/** chunk 类变体共有的 content（宽容形状由 parseChunkText 统一抽取文本）。 */
export interface ContentChunkUpdate {
  readonly sessionUpdate:
    "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  readonly content: unknown;
  readonly messageId?: string;
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** 工具调用及更新的已知字段。 */
export interface ToolCallUpdateBase {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: unknown;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export type ToolCallSessionUpdate = ToolCallUpdateBase & {
  readonly sessionUpdate: "tool_call";
};

export type ToolCallUpdateSessionUpdate = ToolCallUpdateBase & {
  readonly sessionUpdate: "tool_call_update";
};

export type PlanEntryStatus = "pending" | "in_progress" | "completed";
export type PlanEntryPriority = "high" | "medium" | "low";

export interface PlanEntry {
  readonly content: string;
  readonly priority: PlanEntryPriority;
  readonly status: PlanEntryStatus;
}

export interface PlanSessionUpdate {
  readonly sessionUpdate: "plan";
  readonly entries: readonly PlanEntry[];
}

export interface UsageUpdateSessionUpdate {
  readonly sessionUpdate: "usage_update";
  /** 上下文窗口总 token 数。 */
  readonly size: number;
  /** 当前已占用 token 数。 */
  readonly used: number;
}

export interface SessionInfoUpdate {
  readonly sessionUpdate: "session_info_update";
  /** null 表示清除标题。 */
  readonly title?: string | null;
  readonly updatedAt?: string;
}

export interface CurrentModeUpdate {
  readonly sessionUpdate: "current_mode_update";
  readonly currentModeId: string;
}

/** 原样保留尚未识别的变体。 */
export interface OpaqueSessionUpdate {
  readonly sessionUpdate:
    "available_commands_update" | "config_option_update" | (string & {});
  readonly [key: string]: unknown;
}

export type SessionUpdateVariant =
  | ContentChunkUpdate
  | ToolCallSessionUpdate
  | ToolCallUpdateSessionUpdate
  | PlanSessionUpdate
  | UsageUpdateSessionUpdate
  | SessionInfoUpdate
  | CurrentModeUpdate
  | OpaqueSessionUpdate;

export interface SessionUpdateNotificationParams {
  readonly sessionId: string;
  readonly update: SessionUpdateVariant;
}

// ---------------------------------------------------------------------------
// Private extension wire types live in their adapter modules.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agent→client 反向请求
// ---------------------------------------------------------------------------

/** `session/request_permission` 请求参数（toolCall 即 ToolCallUpdateBase 形状）。 */
export interface RequestPermissionRequestParams {
  readonly sessionId: string;
  readonly toolCall: ToolCallUpdateBase;
  readonly options: readonly {
    readonly optionId: string;
    readonly name: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
}

/** 权限决策：选中某 option，或取消。 */
export type RequestPermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export interface RequestPermissionResult {
  readonly outcome: RequestPermissionOutcome;
}
