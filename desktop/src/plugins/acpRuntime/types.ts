import type { ServerRequestHandler } from "../acpConnection/types.ts";
import type {
  ContentBlock,
  InitializeResult,
  ListSessionsResult,
  LoadSessionResult,
  McpServer,
  NewSessionResult,
  PromptResult,
  RequestPermissionOutcome,
  SessionInfo,
} from "../../contracts/acp/protocol.ts";
import type {
  ElicitationForm,
  FormResponse,
} from "../../contracts/acp/elicitation.ts";
import type { AgentAdapter } from "../agents/types.ts";
import type { AcpSessionEvent } from "./events.ts";
import type { SessionConfigOption } from "./protocol/configurationTypes.ts";

/** 未识别的审批语义使用中性展示，禁止自动放行。 */
export type PermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always" | "unknown";

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

// ---------------------------------------------------------------------------
// 回调接口（反向请求）
// ---------------------------------------------------------------------------

/** 权限审批回调：返回决策。 */
export type PermissionResponder = (
  sessionId: string,
  toolCall: Readonly<Record<string, unknown>>,
  options: readonly PermissionOption[],
) => Promise<RequestPermissionOutcome>;

export type QuestionResponder = (
  sessionId: string,
  requestId: string,
  questions: readonly AgentQuestion[],
  callerName: string | null,
) => Promise<AgentQuestionResult | null>;

/** 运行时向方言提供的交互回调。 */
export interface AgentDialectHooks {
  readonly onQuestion?: QuestionResponder;
}

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
  readonly agentId?: string;
  readonly supportsCustomAnswers?: () => boolean;
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
  /**
   * 会话创建/恢复时下发给 agent 的 MCP server 清单（ADR 024 §7 改动 1）。
   * 缺省 []，与远端现状逐字节一致；结果通道 MCP 挂载的使能项。
   */
  readonly mcpServers?: readonly McpServer[];
}

export type ChannelSessionOptions = AcpSessionOptions & {
  readonly background?: boolean;
  readonly project?: { readonly id: string; readonly path: string };
};

type SessionRequestOptions = { readonly timeoutMs?: number };

/**
 * session/new 与 session/load 的选项：可按调用覆盖 MCP 清单（缺省用构造时的
 * AcpSessionOptions.mcpServers）。供握手后才能决定 MCP 清单的调用方使用——
 * 如按 Agent 声明的 mcpCapabilities 选择传输（ADR 024 §9-3）。
 */
export type SessionSetupOptions = SessionRequestOptions & {
  readonly mcpServers?: readonly McpServer[];
};

/** One normalized ACP session. The runtime owns the underlying channel. */
export interface AcpSessionPort {
  readonly sessionId: string | null;
  readonly configOptions: readonly SessionConfigOption[];
  readonly models: NewSessionResult["models"];
  readonly modes: NewSessionResult["modes"];
  readonly isInitialized: boolean;
  readonly agentInfo: InitializeResult | null;
  closeSession(): Promise<void>;
  onEvent(listener: (event: AcpSessionEvent) => void): () => void;
  initialize(options?: SessionRequestOptions): Promise<InitializeResult>;
  newSession(
    cwd: string,
    options?: SessionSetupOptions,
  ): Promise<NewSessionResult>;
  loadSession(
    sessionId: string,
    cwd: string,
    options?: SessionSetupOptions,
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
  setConfigOption(
    configId: string,
    value: string,
    options?: SessionRequestOptions,
  ): Promise<void>;
}

export interface AcpProtocolRestoreOptions {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly modelId: string | null;
  readonly modeId?: string;
  readonly configuration: readonly SessionConfigOption[];
  readonly isCurrent: () => boolean;
  readonly onReplay: (event: AcpSessionEvent) => void;
}

export interface AcpProtocolSessionOptions
  extends
    Omit<
      ChannelSessionOptions,
      "clientInfo" | "cancellationGraceMs" | "dialect"
    >,
    AgentDialectHooks {}

export type AcpConnectionPreparationEvent =
  | { readonly kind: "starting" | "handshake" | "ready" }
  | { readonly kind: "failed"; readonly error: string };

/** ACP 会话与连接资源。项目层通过此端口协调 Agent 切换及会话投影。 */
export interface AcpProtocolResources {
  readonly selection:
    { readonly agentKey: string; readonly agentId: string } | undefined;
  prepare(
    adapter: AgentAdapter,
    agentKey: string,
    toolPaths: object,
  ): Promise<void>;
  prepareSwitch(
    adapter: AgentAdapter,
    toolPaths: object,
    onConnection?: (event: AcpConnectionPreparationEvent) => void,
  ): Promise<number>;
  commitSwitch(revision: number): Promise<void>;
  abortSwitch(revision: number): Promise<void>;
  setSelection(agentKey: string, agentId: string): void;
  open(agentKey: string, options?: AcpProtocolSessionOptions): AcpSessionPort;
  /** 为外部调度的会话创建独立租约，不改变工作台当前 Agent。 */
  openIndependent?(adapter: AgentAdapter, agentKey: string, toolPaths: object, options?: AcpProtocolSessionOptions): Promise<AcpSessionPort>;
  readProjectHistory(
    session: AcpSessionPort,
    workspacePath: string,
    isCurrent: () => boolean,
  ): Promise<readonly SessionInfo[] | null>;
  has(session: AcpSessionPort): boolean;
  promote(session: AcpSessionPort): void;
  release(session: AcpSessionPort): Promise<void>;
  recover(session: AcpSessionPort): Promise<void>;
  restore(
    session: AcpSessionPort,
    options: AcpProtocolRestoreOptions,
  ): Promise<void>;
  close(options?: { force?: boolean }): Promise<void>;
}

/** 通用选择题展示模型。 */
export interface AgentQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { label: string; description: string }[];
  readonly multiSelect: boolean;
}

/** 一问的答案：选中的 label 列表 + 可选备注。 */
export interface AgentAnswer {
  readonly values: readonly string[];
  readonly note?: string;
}

/** Structured question response supplied by the shared question UI. */
export interface AgentQuestionResult {
  readonly answers?: readonly AgentAnswer[];
  readonly cancelled?: boolean;
}

export type { SessionConfigOption } from "./protocol/configurationTypes.ts";

export type {
  AgentCommandEntry,
  AgentUsageReport,
  EditPayload,
  McpServerEntry,
  RuntimeSnapshot,
  SubagentProgress,
  SubagentCompaction,
  SubagentToolEvidence,
  SubagentToolRecord,
  SubagentMessage,
  SubagentToolPresentation,
} from "./protocol/normalizedEvents.ts";
