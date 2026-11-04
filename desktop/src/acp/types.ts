/**
 * ACP（Agent Client Protocol）线上类型 —— chrys 方言。
 *
 * 权威对照：
 * - chrys 服务端实际运行的 Python `acp` SDK（schema ref v0.12.2）：
 *   `D:/dev/workspace-ai/chrys/.venv/Lib/site-packages/acp/schema.py`；
 * - chrys 的请求处理器与扩展通知 payload：
 *   `D:/dev/workspace-ai/chrys/src/chrys/app/acp/server.py`。
 *
 * 与 npm 包 `@agentclientprotocol/sdk`（v2.0.0）的差异说明：该包的
 * v1/unstable schema 已新增 `plan_update` / `plan_removed` 等 chrys 尚未
 * 发送的变体，`StopReason` 等枚举也与 chrys 侧不完全一致。为保证「线上
 * 形状以 chrys 源码为准」，本层不 re-export SDK 类型，而是独立维护
 * chrys 实际收发的类型；SDK 仅作为协议演进的对照参考。
 *
 * 分帧：ACP stdio 是**行分帧**（每行一个 UTF-8 JSON-RPC 2.0 消息，
 * `\n` 结尾），不是 LSP 的 Content-Length 分帧。依据：chrys 所用 Python
 * SDK 的读写两侧均为 readline（`acp/connection.py` / `acp/stdio.py`）。
 *
 * 类型约定：
 * - 请求/响应参数按 chrys 实际发送的字段定义；服务端可能缺省的字段标 `?`；
 * - 解析侧（session.ts）以 `unknown` + 类型守卫收窄，绝不 `as` 强转。
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
  /** agent→client 请求：chrys 扩展的结构化提问（Python SDK ext_method 自动加 `_` 前缀）。 */
  chrysRequestInput: "_chrys/request_input",
  /** chrys 扩展通知（ext_notification 自动加 `_` 前缀）。 */
  chrysRuntimeUpdate: "_chrys/runtime_update",
  chrysUsageUpdate: "_chrys/usage_update",
  chrysError: "_chrys/error",
  chrysWarning: "_chrys/warning",
} as const;

/** 客户端支持的最新协议版本（与 chrys / ACP SDK 的 PROTOCOL_VERSION 一致）。 */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// content block（prompt 与 chunk 共用）
// ---------------------------------------------------------------------------

/** 文本块（当前客户端唯一构造的 prompt 块类型）。 */
export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * agent 发来的 chunk content：可能是文本块、也可能是 chrys 各种嵌套
 * 宽容形状（字符串、`{ text }`、`[{ content: { text } }]`）。
 * 解析用 `parseChunkText`，这里只描述已知形状。
 */
export type ContentBlock = TextContentBlock;

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

export interface PromptCapabilities {
  readonly embeddedContext: boolean;
  readonly image: boolean;
  readonly audio: boolean;
}

export interface McpCapabilities {
  readonly http: boolean;
  readonly sse: boolean;
}

export interface SessionCapabilities {
  readonly close: Record<string, never>;
  readonly list: Record<string, never>;
  readonly additionalDirectories: Record<string, never>;
}

export interface AgentCapabilities {
  readonly loadSession: boolean;
  readonly promptCapabilities: PromptCapabilities;
  readonly mcpCapabilities: McpCapabilities;
  readonly sessionCapabilities: SessionCapabilities;
  /** chrys 显式置 null（见 server.py initialize 注释）。 */
  readonly auth: null;
}
export interface InitializeRequestParams {
  readonly protocolVersion: number;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo: Implementation;
  /**
   * agent 能力声明。字段随协议演进增减且仅诊断展示用，本客户端不逐
   * 字段消费，故按原样透传（chrys 当前形状见 AgentCapabilities）。
   */
  readonly agentCapabilities: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// session/new | load | list
// ---------------------------------------------------------------------------

/** stdio MCP server 配置（session/new 的 mcpServers 元素；当前客户端只发空数组）。 */
export interface McpServerStdio {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** 审批模式（chrys：manual / auto / bypass，见 server.py `_APPROVAL_MODES`）。 */
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
  readonly mcpServers: readonly McpServerStdio[];
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
  readonly mcpServers: readonly McpServerStdio[];
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
  readonly prompt: readonly TextContentBlock[];
  /** 客户端侧消息 id（回显在响应的 userMessageId）。 */
  readonly messageId?: string;
}

/** stopReason 全集（chrys 的 Python SDK Literal：server.py prompt() 实际发 end_turn / cancelled / error）。 */
export type StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** 一轮 prompt 的用量（chrys `_prompt_usage_payload`：会话累计口径）。 */
export interface PromptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedReadTokens?: number;
}

export interface PromptResult {
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
// session/update 通知（update 变体全集 = chrys Python SDK v0.12.2）
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

/** 工具调用开始（除 toolCallId 外 chrys 可能缺省其余字段）。 */
export interface ToolCallUpdateBase {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: unknown;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  /** chrys 权限请求里携带 `_meta.chrys = { tool_name, tool_kind }`。 */
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

/** available_commands_update 的单条命令（agent 侧斜杠命令）。 */
export interface AgentCommandEntry {
  readonly name: string;
  readonly description: string | null;
  /** 参数提示（input.hint；如「optional custom review instructions」）。 */
  readonly inputHint: string | null;
}

export interface CurrentModeUpdate {
  readonly sessionUpdate: "current_mode_update";
  readonly currentModeId: string;
}

/** 其余标准变体（chrys 会发但当前 UI 不消费；原样透传）。 */
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
// chrys 扩展通知（`_chrys/*`，payload 依据 server.py 各 ext_notification 调用点）
// ---------------------------------------------------------------------------

/** `_chrys/runtime_update` 的 runtime 对象（chrys 0.22.x：toolNames/skillNames 在顶层）。 */
export interface ChrysRuntime {
  readonly sessionId?: string;
  readonly agentProfile?: string;
  readonly displayName?: string;
  readonly modelProfileId?: string | null;
  readonly maxContextTokens?: number | null;
  readonly toolNames?: readonly string[];
  readonly toolKinds?: readonly string[];
  readonly skillNames?: readonly string[];
  readonly subAgentToolNames?: readonly string[];
  readonly memoryFiles?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** 引擎运行时详情（形状随 chrys 版本变化，原样透传）。 */
  readonly runtimeDetails?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ChrysRuntimeUpdateParams {
  readonly sessionId: string;
  readonly runtime: ChrysRuntime;
}

/** `_chrys/usage_update`（比标准 usage_update 的字段丰富得多）。 */
export interface ChrysUsageUpdateParams {
  readonly sessionId: string;
  readonly agentProfile?: string;
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

export interface ChrysErrorParams {
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly recoverable?: boolean;
}

export interface ChrysWarningParams {
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// agent→client 反向请求
// ---------------------------------------------------------------------------

/**
 * 权限选项 kind。`unknown` 是本客户端的守卫回落：协议演进出现表外
 * 取值（或 kind 缺失）时按 unknown 呈现——kind 决定按钮语义（允许 /
 * 拒绝），未知语义若回落 allow 会以「允许」风格渲染未知选项，属于
 * 权限审批面上不安全方向的默认。UI 会以中性样式呈现并保留 agent 的
 * 原始 name（见 ApprovalModal）。
 */
export type PermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always" | "unknown";

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

/** `session/request_permission` 请求参数（toolCall 即 ToolCallUpdateBase 形状）。 */
export interface RequestPermissionRequestParams {
  readonly sessionId: string;
  readonly toolCall: ToolCallUpdateBase;
  readonly options: readonly PermissionOption[];
}

/** 权限决策：选中某 option，或取消。 */
export type RequestPermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export interface RequestPermissionResult {
  readonly outcome: RequestPermissionOutcome;
}

/** `_chrys/request_input` 的一问。 */
export interface AgentQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { label: string; description: string }[];
  readonly multiSelect: boolean;
}

/** `_chrys/request_input` 请求参数（chrys `AskUserQuestion` 序列化形状）。 */
export interface ChrysRequestInputParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly questions: readonly ChrysQuestion[];
  readonly callerName?: string;
}

/** 一问的答案：选中的 label 列表 + 可选备注。 */
export interface AgentAnswer {
  readonly values: readonly string[];
  readonly note?: string;
}

/**
 * `_chrys/request_input` 响应。chrys 侧严格校验（ask_user.py
 * `validate_request_input_response`）：只接受 `answers` / `cancelled` /
 * `_meta` 三个键，answer 只接受 `values` / `note`。
 */
export interface AgentQuestionResult {
  readonly answers?: readonly AgentAnswer[];
  readonly cancelled?: boolean;
}

/** ICode wire compatibility aliases; UI consumes the neutral question domain. */
export type ChrysQuestion = AgentQuestion;
export type ChrysAnswer = AgentAnswer;
export type ChrysRequestInputResult = AgentQuestionResult;
