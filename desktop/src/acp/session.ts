/**
 * ACP 会话生命周期封装。
 *
 * 把 connection 的 wire 通知翻译成**类型化事件流**，把请求/响应守卫收窄
 * 后暴露为面向领域的方法：
 *
 *   initialize → newSession / loadSession / listSessions
 *   → prompt（期间事件流持续派发）→ cancel → setMode / setModel → close
 *
 * agent→client 的标准反向请求（`session/request_permission`）通过可注入
 * 的回调处理；未注入时采用**安全缺省**：权限一律取消，绝不静默放行。
 *
 * 方言扩展点（`AcpDialect`，由 src/agents 的适配注册层注入）：agent 的
 * 私有通知翻译与私有反向请求处理器都从这里挂接，本层不硬编码任何具体
 * agent 的私有方法名——接入第二种 agent 时协议层无需改动。
 */

import { createLogger } from "../core/logger.ts";
import {
  AcpHandshakeError,
  AcpResponseError,
  AcpTimeoutError,
} from "./errors.ts";
import { AcpConnection } from "./connection.ts";
import type { ServerRequestHandler } from "./connection.ts";
import type { AcpTransport, TransportExit } from "./transport/acpTransport.ts";
import { ACP_METHOD, ACP_PROTOCOL_VERSION } from "./types.ts";
import { asNumber, asRecord, asString } from "./parse.ts";
import type {
  AgentCommandEntry,
  ChrysRuntime,
  ChrysUsageUpdateParams,
  InitializeResult,
  ListSessionsResult,
  LoadSessionResult,
  ModelInfo,
  NewSessionResult,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  PromptResult,
  RequestPermissionOutcome,
  SessionInfo,
  SessionMode,
  StopReason,
  TextContentBlock,
  ToolCallStatus,
  ToolKind,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 类型化事件
// ---------------------------------------------------------------------------

/** session 层派发的全部事件（判别字段 `type`）。 */
export type AcpSessionEvent =
  | {
      readonly type:
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      readonly sessionId: string;
      /** 宽容抽取的文本（chrys 的 content 形状多样，见 parseChunkText）。 */
      readonly text: string;
      readonly messageId?: string;
    }
  | {
      readonly type: "tool_call" | "tool_call_update";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly title?: string;
      readonly kind?: ToolKind;
      readonly status?: ToolCallStatus;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
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
    }
  | {
      readonly type: "chrys_runtime";
      readonly sessionId: string;
      readonly runtime: ChrysRuntime;
    }
  | {
      readonly type: "chrys_usage";
      readonly sessionId: string;
      readonly usage: ChrysUsageUpdateParams;
    }
  | {
      readonly type: "chrys_error";
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
      readonly recoverable: boolean | null;
    }
  | {
      readonly type: "chrys_warning";
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
    }
  | {
      /** 其余 chrys 扩展通知（session_restored / sub_agent_* 等）原样透传。 */
      readonly type: "chrys_extension";
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      /** 未识别的 session/update 变体或非 chrys 通知：原样透传，不丢数据。 */
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
 * 仍由本层负责。由 src/agents 的适配注册层构造（见 registry.ts 的
 * `createDialect`）。
 */
export interface AcpDialect {
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
  readonly requestTimeoutMs?: number;
  /** 权限审批回调（标准 ACP `session/request_permission`）；缺省自动取消（安全默认）。 */
  readonly onPermissionRequest?: PermissionResponder;
  /** agent 方言挂接（私有通知翻译 + 私有反向请求）；纯标准 ACP agent 可省略。 */
  readonly dialect?: AcpDialect;
  /** 客户端标识（initialize 握手用）。 */
  readonly clientInfo?: { readonly name: string; readonly version?: string };
}

/** close() 的结构化结果（见 close 注释：吞错路径的可观测出口）。 */
export interface SessionCloseOutcome {
  /**
   * session/close 请求结果：ok = 对端确认；failed = 请求失败（已继续
   * 清理进程，原因见 sessionCloseReason）；skipped = 无活动会话未发送。
   */
  readonly sessionClose: "ok" | "failed" | "skipped";
  /** failed 时的原因（错误名 + 消息）。 */
  readonly sessionCloseReason?: string;
  /** agent 进程最终退出状态（自然退出或被强杀）。 */
  readonly exit: TransportExit;
}

const DEFAULT_CLIENT_INFO = { name: "aaw-desktop", version: "0.1.0" } as const;

// ---------------------------------------------------------------------------
// AcpSession
// ---------------------------------------------------------------------------

export class AcpSession {
  private readonly connection: AcpConnection;
  private readonly logger = createLogger("acp");
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>();
  private readonly permissionResponder: PermissionResponder | undefined;
  private readonly dialect: AcpDialect | undefined;
  private readonly clientInfo: {
    readonly name: string;
    readonly version?: string;
  };

  /** 握手结果（initialize 成功后有效）。 */
  private handshake: InitializeResult | null = null;
  /** 当前（最近一次 new/load 的）会话 id。 */
  sessionId: string | null = null;
  /** 最近一次 new/load 返回的模型状态。 */
  models: NewSessionResult["models"] = null;
  /** 最近一次 new/load 返回的模式状态。 */
  modes: NewSessionResult["modes"] = null;

  constructor(transport: AcpTransport, options: AcpSessionOptions = {}) {
    this.connection = new AcpConnection(transport, {
      requestTimeoutMs: options.requestTimeoutMs,
      logger: this.logger,
    });
    this.permissionResponder = options.onPermissionRequest;
    this.dialect = options.dialect;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.connection.setNotificationHandler((method, params) => {
      this.dispatchNotification(method, params);
    });
    this.connection.setServerRequestHandler(async (method, params) =>
      this.handleServerRequest(method, params),
    );
  }

  /** 订阅事件流，返回退订函数。 */
  onEvent(listener: (event: AcpSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------- 生命周期

  /**
   * 握手：initialize + 版本协商。
   *
   * chrys 返回 `min(客户端请求, 服务端支持)`（server.py initialize）；
   * 本客户端只支持 1，因此校验响应版本必须是正整数且不高于请求版本，
   * 否则视为协商失败。
   */
  async initialize(
    options: { timeoutMs?: number } = {},
  ): Promise<InitializeResult> {
    const raw = await this.connection.request(
      ACP_METHOD.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: this.clientInfo,
      },
      options,
    );
    const result = asInitializeResult(raw);
    if (result === null) {
      throw new AcpHandshakeError(
        `initialize 响应形状不合法：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    const version = result.protocolVersion;
    if (
      !Number.isInteger(version) ||
      version <= 0 ||
      version > ACP_PROTOCOL_VERSION
    ) {
      throw new AcpHandshakeError(
        `协议版本协商失败：客户端请求 ${ACP_PROTOCOL_VERSION}，服务端响应 ${String(version)}`,
      );
    }
    this.handshake = result;
    this.logger.info(
      `ACP 已初始化 · agent ${result.agentInfo.name} ${result.agentInfo.version ?? "?"}`,
    );
    return result;
  }

  /** 是否已完成握手。 */
  get isInitialized(): boolean {
    return this.handshake !== null;
  }

  /** 握手结果快照。 */
  get agentInfo(): InitializeResult | null {
    return this.handshake;
  }

  /** 建新会话。 */
  async newSession(
    cwd: string,
    options: { timeoutMs?: number } = {},
  ): Promise<NewSessionResult> {
    const raw = await this.connection.request(
      ACP_METHOD.sessionNew,
      { cwd, mcpServers: [] },
      options,
    );
    const result = asNewSessionResult(raw);
    if (result === null) {
      throw new AcpHandshakeError(
        `session/new 响应形状不合法（缺少 sessionId）：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    this.sessionId = result.sessionId;
    this.models = result.models;
    this.modes = result.modes;
    this.logger.info(`会话已建立 · sessionId ${result.sessionId.slice(0, 8)}…`);
    return result;
  }

  /** 恢复已保存的会话（chrys 声明了 loadSession 能力）。 */
  async loadSession(
    sessionId: string,
    cwd: string,
    options: { timeoutMs?: number } = {},
  ): Promise<LoadSessionResult> {
    const raw = await this.connection.request(
      ACP_METHOD.sessionLoad,
      { sessionId, cwd, mcpServers: [] },
      options,
    );
    const result = asLoadSessionResult(raw);
    if (result === null) {
      throw new AcpHandshakeError(
        `session/load 响应形状不合法：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    this.sessionId = sessionId;
    this.models = result.models;
    this.modes = result.modes;
    return result;
  }

  /** 列出该 cwd 下的已保存会话。 */
  async listSessions(
    cwd?: string,
    options: { cursor?: string; timeoutMs?: number } = {},
  ): Promise<ListSessionsResult> {
    const params: Record<string, unknown> = {};
    if (cwd !== undefined) {
      params.cwd = cwd;
    }
    if (options.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    const raw = await this.connection.request(ACP_METHOD.sessionList, params, {
      timeoutMs: options.timeoutMs,
    });
    return asListSessionsResult(raw);
  }

  // --------------------------------------------------------------- 交互

  /**
   * 发送一轮 prompt。响应到达前，通知流照常派发为事件；
   * 默认不限制整轮时长，直到完成、取消确认或连接退出；短请求的超时
   * 不适用于模型、工具和人工审批。返回 PromptResult（stopReason / usage）。
   */
  async prompt(
    text: string,
    options: { timeoutMs?: number } = {},
  ): Promise<PromptResult> {
    this.assertSession();
    const blocks: TextContentBlock[] = [{ type: "text", text }];
    const raw = await this.connection.request(
      ACP_METHOD.sessionPrompt,
      { sessionId: this.sessionId, prompt: blocks },
      { timeoutMs: options.timeoutMs ?? null },
    );
    const result = asPromptResult(raw);
    if (result === null) {
      throw new AcpResponseError(
        ACP_METHOD.sessionPrompt,
        -32603,
        `响应形状不合法（stopReason 缺失或非法）：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    return result;
  }

  /** 请求取消当前轮（通知；轮次结果由 prompt 的响应带回 stopReason=cancelled）。 */
  cancel(): void {
    if (this.sessionId === null) {
      return;
    }
    this.connection.notify(
      ACP_METHOD.sessionCancel,
      {
        sessionId: this.sessionId,
      },
      { throwOnError: true },
    );
    this.logger.info("已请求取消当前轮次（session/cancel）");
  }

  /** 切换审批模式（manual / auto / bypass）。 */
  async setMode(
    modeId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.assertSession();
    await this.connection.request(
      ACP_METHOD.sessionSetMode,
      { sessionId: this.sessionId, modeId },
      options,
    );
  }

  /** 切换会话模型（Chrys Model Profile id）。 */
  async setModel(
    modelId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.assertSession();
    await this.connection.request(
      ACP_METHOD.sessionSetModel,
      { sessionId: this.sessionId, modelId },
      options,
    );
  }

  /**
   * 关闭会话并终止 agent 进程：
   * session/close（15s 上限，失败不阻断）→ transport.close（关 stdin 等
   * 自退）→ 超时升级 kill（进程树终止）。幂等。
   *
   * 返回结构化结果：调用方（冒烟脚本 / 诊断页）需要区分「session/close
   * 被对端确认」与「仅完成了进程清理」——close 内部按约定吞掉
   * session/close 的失败继续清理，不抛错，结果只能从返回值读。
   */
  async close(
    options: { closeTimeoutMs?: number } = {},
  ): Promise<SessionCloseOutcome> {
    const sessionId = this.sessionId;
    let sessionClose: SessionCloseOutcome["sessionClose"] = "skipped";
    let sessionCloseReason: string | undefined;
    if (sessionId !== null) {
      try {
        await this.connection.request(
          ACP_METHOD.sessionClose,
          { sessionId },
          { timeoutMs: options.closeTimeoutMs ?? 15_000 },
        );
        sessionClose = "ok";
      } catch (error) {
        // 关闭失败不阻断进程清理（Python 参考同样 suppress），但把结果
        // 如实带回给调用方
        sessionClose = "failed";
        sessionCloseReason =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        this.logger.warn("session/close 未成功，继续清理进程", {
          reason: sessionCloseReason,
        });
      }
    }
    const exit = await this.connection.underlying.close();
    this.sessionId = null;
    return sessionClose === "failed"
      ? { sessionClose, sessionCloseReason, exit }
      : { sessionClose, exit };
  }

  /** 强制终止（不等优雅关闭；Windows 上杀整棵进程树）。返回终态供退出
   * 路径打点：code/signal 是收口是否干净的直接证据。 */
  async kill(): Promise<TransportExit> {
    const exit = await this.connection.underlying.kill();
    this.sessionId = null;
    return exit;
  }

  // ------------------------------------------------------------- 通知派发

  private dispatchNotification(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    try {
      const event = this.translateNotification(method, params);
      if (event !== null) {
        this.emit(event);
      }
    } catch (error) {
      // 单条通知解析失败不拖垮整个流（Python 参考同样防御）
      this.logger.warn(`处理通知 ${method} 失败`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private translateNotification(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): AcpSessionEvent | null {
    // 1) agent 方言钩子先行：第二种 agent 的私有通知在此认领
    const dialectEvent =
      this.dialect?.translateNotification?.(method, params) ?? null;
    if (dialectEvent !== null) {
      return dialectEvent;
    }
    // 2) 标准 ACP 通知
    if (method === ACP_METHOD.sessionUpdate) {
      return translateSessionUpdate(params);
    }
    // 2b) 命名空间风格（`session/update:<variant>`，OpenCode 等生态的 SDK
    // 形式）：语义等价于裸 session/update，但形状是扁平的（变体字段直接
    // 挂在 params 顶层）——归一成裸风格的嵌套 update 再翻译。变体名取
    // params.sessionUpdate，缺省从 method 后缀还原（后缀即变体名）
    if (method.startsWith("session/update:")) {
      const variant = method.slice("session/update:".length);
      const nested = asRecord(params["update"]);
      const update =
        nested !== null
          ? nested
          : typeof params["sessionUpdate"] === "string"
            ? params
            : { ...params, sessionUpdate: variant };
      return translateSessionUpdate({ ...params, update });
    }
    // 3) 兜底：原样透传，不丢数据
    return { type: "unknown_notification", method, params };
  }

  private emit(event: AcpSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("事件监听器抛错", {
          type: event.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ------------------------------------------------------------- 反向请求

  private async handleServerRequest(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    // 1) agent 方言的私有反向请求（如 chrys 的 _chrys/request_input）
    const dialectHandler = this.dialect?.serverRequestHandlers?.get(method);
    if (dialectHandler !== undefined) {
      return dialectHandler(method, params);
    }
    // 2) 标准 ACP 反向请求
    if (method === ACP_METHOD.sessionRequestPermission) {
      // 协议形状：RequestPermissionResponse.outcome 是嵌套对象
      //（{ outcome: "selected", optionId } / { outcome: "cancelled" }），
      // 决策结果本身作为该对象的值回传——扁平回传会被 agent 侧 SDK 的
      // discriminated union 解析拒绝（实测 chrys 报「failed or cancelled」）
      const outcome = await this.handlePermissionRequest(params);
      return { outcome: this.coerceCancelledOutcome(outcome, params) };
    }
    // 未知反向请求：按 JSON-RPC method not found 报回
    throw new Error(`method not found: ${method}`);
  }

  /**
   * 把 cancelled 决策改写为「选中拒绝类选项」（agent 下发了 reject 类
   * 选项时）。部分 agent SDK（如 chrys 0.25.1 的 pydantic union）的
   * RequestPermissionResponse 只声明 selected 形状——回传 cancelled 会
   * 在对端解析抛异常，用户看到的是「失败」而非「已拒绝」；选中明确的
   * 拒绝选项语义等价且协议形状安全。没有拒绝类选项时保留 cancelled。
   */
  private coerceCancelledOutcome(
    outcome: RequestPermissionOutcome,
    params: Readonly<Record<string, unknown>>,
  ): RequestPermissionOutcome {
    if (outcome.outcome !== "cancelled") {
      return outcome;
    }
    const rejectOption = parsePermissionOptions(params["options"]).find(
      (option) =>
        option.kind === "reject_once" || option.kind === "reject_always",
    );
    return rejectOption !== undefined
      ? { outcome: "selected", optionId: rejectOption.optionId }
      : outcome;
  }

  private async handlePermissionRequest(
    params: Readonly<Record<string, unknown>>,
  ): Promise<RequestPermissionOutcome> {
    const sessionId = asString(params["sessionId"]) ?? "";
    const toolCall = asRecord(params["toolCall"]) ?? {};
    const options = parsePermissionOptions(params["options"]);
    const responder = this.permissionResponder;
    if (responder === undefined) {
      this.logger.warn("权限请求无回调，自动取消（安全默认）", {
        sessionId,
        title: asString(toolCall["title"]),
      });
      return { outcome: "cancelled" };
    }
    return responder(sessionId, toolCall, options);
  }

  private assertSession(): void {
    if (this.sessionId === null) {
      throw new AcpHandshakeError(
        "尚未建立 ACP 会话（先 newSession / loadSession）",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// session/update → 事件（宽容收窄；变体全集对照 chrys Python SDK v0.12.2）
// ---------------------------------------------------------------------------

function translateSessionUpdate(
  params: Readonly<Record<string, unknown>>,
): AcpSessionEvent | null {
  const sessionId = asString(params["sessionId"]) ?? "";
  const update = asRecord(params["update"]);
  if (update === null) {
    return null;
  }
  const kind = asString(update["sessionUpdate"]);
  if (kind === null) {
    return null;
  }
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const text = parseChunkText(update["content"]);
      if (text.length === 0) {
        return null;
      }
      const messageId = asString(update["messageId"]);
      return {
        type: kind,
        sessionId,
        text,
        ...(messageId === null ? {} : { messageId }),
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = asString(update["toolCallId"]);
      if (toolCallId === null) {
        return null;
      }
      const title = asString(update["title"]);
      const toolKind = asToolKind(asString(update["kind"]));
      const status = asToolStatus(asString(update["status"]));
      return {
        type: kind,
        sessionId,
        toolCallId,
        ...(title === null ? {} : { title }),
        ...(toolKind === null ? {} : { kind: toolKind }),
        ...(status === null ? {} : { status }),
        ...("rawInput" in update ? { rawInput: update["rawInput"] } : {}),
        ...("rawOutput" in update ? { rawOutput: update["rawOutput"] } : {}),
      };
    }
    case "plan":
      return {
        type: "plan",
        sessionId,
        entries: parsePlanEntries(update["entries"]),
      };
    case "usage_update":
      return {
        type: "usage_update",
        sessionId,
        contextSize: asNumber(update["size"]),
        contextUsed: asNumber(update["used"]),
      };
    case "available_commands_update": {
      const commands = parseAgentCommands(update["availableCommands"]);
      return { type: "available_commands", sessionId, commands };
    }
    case "session_info_update": {
      const updatedAt = asString(update["updatedAt"]);
      return {
        type: "session_info_update",
        sessionId,
        title: asString(update["title"]),
        ...(updatedAt === null ? {} : { updatedAt }),
      };
    }
    case "current_mode_update": {
      const modeId = asString(update["currentModeId"]);
      if (modeId === null) {
        return null;
      }
      return { type: "current_mode_update", sessionId, modeId };
    }
    default:
      // available_commands_update / config_option_update / 未来变体
      return {
        type: "unknown_notification",
        method: `session/update:${kind}`,
        params: update,
      };
  }
}

/**
 * 宽容抽取 chunk 文本。chrys 的 content 形状包括：
 * `{type:"text", text}`（标准）、裸字符串、`{ text }`、
 * `[{ content: { text } }]`（嵌套，见 skill-eval 测试夹具）。
 * 对齐 Python wire.py 的 chunk_text 递归。
 */
export function parseChunkText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    let out = "";
    for (const item of content) {
      out += parseChunkText(item);
    }
    return out;
  }
  if (typeof content === "object") {
    const record = content as Readonly<Record<string, unknown>>;
    const text = record["text"];
    if (typeof text === "string") {
      return text;
    }
    return parseChunkText(record["content"]);
  }
  return "";
}

function parsePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: PlanEntry[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const content = asString(record["content"]);
    if (content === null) {
      continue;
    }
    const priority = asPlanPriority(asString(record["priority"]));
    const status = asPlanStatus(asString(record["status"]));
    entries.push({
      content,
      // 白名单外（含缺失）的取值回落默认，保证事件形状稳定
      priority: priority ?? "medium",
      status: status ?? "pending",
    });
  }
  return entries;
}

/** 收窄 available_commands_update 的 availableCommands 数组（坏项丢弃）。 */
function parseAgentCommands(raw: unknown): AgentCommandEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const commands: AgentCommandEntry[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const name = asString(record["name"]);
    if (name === null) {
      continue;
    }
    const description = asString(record["description"]);
    const input = asRecord(record["input"]);
    const inputHint = input === null ? null : asString(input["hint"]);
    commands.push({
      name,
      description,
      inputHint,
    });
  }
  return commands;
}

const PLAN_PRIORITIES: readonly PlanEntry["priority"][] = [
  "high",
  "medium",
  "low",
];
const PLAN_STATUSES: readonly PlanEntry["status"][] = [
  "pending",
  "in_progress",
  "completed",
];

function asPlanPriority(raw: string | null): PlanEntry["priority"] | null {
  if (raw === null) {
    return null;
  }
  return PLAN_PRIORITIES.find((value) => value === raw) ?? null;
}

function asPlanStatus(raw: string | null): PlanEntry["status"] | null {
  if (raw === null) {
    return null;
  }
  return PLAN_STATUSES.find((value) => value === raw) ?? null;
}

function parsePermissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: PermissionOption[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const optionId = asString(record["optionId"]);
    const name = asString(record["name"]);
    if (optionId === null || name === null) {
      continue;
    }
    options.push({
      optionId,
      name,
      kind: asPermissionOptionKind(asString(record["kind"])),
    });
  }
  return options;
}

// ---------------------------------------------------------------------------
// 响应守卫
// ---------------------------------------------------------------------------

function asInitializeResult(raw: unknown): InitializeResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const protocolVersion = record["protocolVersion"];
  const agentInfo = asRecord(record["agentInfo"]);
  const agentName = agentInfo === null ? null : asString(agentInfo["name"]);
  if (typeof protocolVersion !== "number" || agentName === null) {
    return null;
  }
  const version = agentInfo === null ? null : asString(agentInfo["version"]);
  return {
    protocolVersion,
    agentInfo: { name: agentName, ...(version === null ? {} : { version }) },
    agentCapabilities: asRecord(record["agentCapabilities"]) ?? {},
  };
}

function asNewSessionResult(raw: unknown): NewSessionResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const sessionId = asString(record["sessionId"]);
  if (sessionId === null || sessionId.length === 0) {
    return null;
  }
  return {
    sessionId,
    modes: asModeState(record["modes"]),
    models: asModelState(record["models"]),
  };
}

function asLoadSessionResult(raw: unknown): LoadSessionResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  return {
    modes: asModeState(record["modes"]),
    models: asModelState(record["models"]),
  };
}

function asListSessionsResult(raw: unknown): ListSessionsResult {
  const record = asRecord(raw);
  if (record === null) {
    return { sessions: [] };
  }
  const sessions: SessionInfo[] = [];
  const rawSessions = record["sessions"];
  if (Array.isArray(rawSessions)) {
    for (const item of rawSessions) {
      const entry = asRecord(item);
      if (entry === null) {
        continue;
      }
      const sessionId = asString(entry["sessionId"]);
      const cwd = asString(entry["cwd"]);
      if (sessionId === null || cwd === null) {
        continue;
      }
      const title = asString(entry["title"]);
      const updatedAt = asString(entry["updatedAt"]);
      sessions.push({
        sessionId,
        cwd,
        ...(title === null ? {} : { title }),
        ...(updatedAt === null ? {} : { updatedAt }),
      });
    }
  }
  const nextCursor = asString(record["nextCursor"]);
  return { sessions, ...(nextCursor === null ? {} : { nextCursor }) };
}

function asModeState(raw: unknown): NewSessionResult["modes"] {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const currentModeId = asString(record["currentModeId"]);
  if (currentModeId === null) {
    return null;
  }
  const modes: SessionMode[] = [];
  const rawModes = record["availableModes"];
  if (Array.isArray(rawModes)) {
    for (const item of rawModes) {
      const entry = asRecord(item);
      if (entry === null) {
        continue;
      }
      const id = asString(entry["id"]);
      const name = asString(entry["name"]);
      if (id === null || name === null) {
        continue;
      }
      const description = asString(entry["description"]);
      modes.push({
        id,
        name,
        ...(description === null ? {} : { description }),
      });
    }
  }
  return { currentModeId, availableModes: modes };
}

function asModelState(raw: unknown): NewSessionResult["models"] {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const models: ModelInfo[] = [];
  const rawModels = record["availableModels"];
  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      const entry = asRecord(item);
      if (entry === null) {
        continue;
      }
      const modelId = asString(entry["modelId"]);
      const name = asString(entry["name"]);
      if (modelId === null || name === null) {
        continue;
      }
      const description = asString(entry["description"]);
      models.push({
        modelId,
        name,
        ...(description === null ? {} : { description }),
      });
    }
  }
  return {
    currentModelId: asString(record["currentModelId"]),
    availableModels: models,
  };
}

const STOP_REASONS: readonly StopReason[] = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
];

function asPromptResult(raw: unknown): PromptResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const stopReasonRaw = asString(record["stopReason"]);
  if (stopReasonRaw === null) {
    return null;
  }
  const stopReason = STOP_REASONS.find((value) => value === stopReasonRaw);
  if (stopReason === undefined) {
    return null;
  }
  const usageRecord = asRecord(record["usage"]);
  if (usageRecord === null) {
    return { stopReason };
  }
  const cachedReadTokens = asNumber(usageRecord["cachedReadTokens"]);
  return {
    stopReason,
    usage: {
      inputTokens: asNumber(usageRecord["inputTokens"]) ?? 0,
      outputTokens: asNumber(usageRecord["outputTokens"]) ?? 0,
      totalTokens: asNumber(usageRecord["totalTokens"]) ?? 0,
      ...(cachedReadTokens === null ? {} : { cachedReadTokens }),
    },
  };
}

// ---------------------------------------------------------------------------
// 基础守卫（实现移至 parse.ts，供各 agent 方言共用）
// ---------------------------------------------------------------------------

const TOOL_KINDS: readonly ToolKind[] = [
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

function asToolKind(raw: string | null): ToolKind | null {
  if (raw === null) {
    return null;
  }
  return TOOL_KINDS.find((value) => value === raw) ?? null;
}

const TOOL_STATUSES: readonly ToolCallStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
];

function asToolStatus(raw: string | null): ToolCallStatus | null {
  if (raw === null) {
    return null;
  }
  return TOOL_STATUSES.find((value) => value === raw) ?? null;
}

const PERMISSION_OPTION_KINDS: readonly PermissionOptionKind[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
];

function asPermissionOptionKind(raw: string | null): PermissionOptionKind {
  // 表外取值或缺失一律回落 unknown（中性）：kind 决定按钮语义，未知
  // 语义回落 "allow_once" 会以「允许」主按钮风格渲染未知选项，在权限
  // 审批面上是不安全方向的默认——与本层「绝不静默放行」的安全缺省
  // 相悖。UI 按 unknown 呈现选项原始 name，由用户自行判断。
  if (raw === null) {
    return "unknown";
  }
  return PERMISSION_OPTION_KINDS.find((value) => value === raw) ?? "unknown";
}

/** 再导出超时错误，方便上层精确 catch。 */
export { AcpTimeoutError };
