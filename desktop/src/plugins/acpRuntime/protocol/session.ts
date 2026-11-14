import type {
  AcpDialect,
  AcpSessionOptions,
  AcpSessionPort,
  AgentCommandEntry,
  PermissionOption,
  PermissionOptionKind,
  PermissionResponder,
  SessionSetupOptions,
} from "../types.ts";
import type { AcpSessionEvent } from "../events.ts";
import type { AcpSessionConnection } from "../../acpConnection/types.ts";
import {
  nonTextContent,
  parseChunkText,
} from "../../../contracts/acp/content.ts";
import { parseToolLocations } from "../../../contracts/acp/toolLocations.ts";
import { parseToolKind } from "../../../contracts/acp/tools.ts";
import { parseRuntimeElicitationForm } from "./elicitation.ts";
import {
  parseConfigOptions,
  configModels,
  configModes,
} from "./configOptions.ts";
import type { SessionConfigOption } from "./configurationTypes.ts";
/**
 * ACP 单通道协议封装；连接创建、故障与进程生命周期由 AcpConnection 管理。
 *
 * 把 connection 的 wire 通知翻译成**类型化事件流**，把请求/响应守卫收窄
 * 后暴露为面向领域的方法：
 *
 *   initialize → newSession / loadSession / listSessions
 *   → prompt（期间事件流持续派发）→ cancel → setMode / setModel → closeSession
 *
 * agent→client 的标准反向请求（`session/request_permission`）通过可注入
 * 的回调处理；未注入时采用**安全缺省**：权限一律取消，绝不静默放行。
 *
 * 方言扩展点（`AcpDialect`，由 src/agents 的适配注册层注入）：agent 的
 * 私有通知翻译与私有反向请求处理器都从这里挂接，本层不硬编码任何具体
 * agent 的私有方法名——接入第二种 agent 时协议层无需改动。
 */

import { createLogger } from "../../../shared/logging/logger.ts";
import { AcpHandshakeError } from "./handshakeError.ts";
import {
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
} from "../../acpConnection/service.ts";

import {
  ACP_METHOD,
  ACP_PROTOCOL_VERSION,
} from "../../../contracts/acp/protocol.ts";
import { asNumber, asRecord, asString } from "../../../shared/valueGuards.ts";
import type {
  InitializeResult,
  ListSessionsResult,
  LoadSessionResult,
  McpServer,
  ModelInfo,
  NewSessionResult,
  PlanEntry,
  PromptResult,
  RequestPermissionOutcome,
  SessionInfo,
  SessionMode,
  StopReason,
  ContentBlock,
  ToolCallStatus,
} from "../../../contracts/acp/protocol.ts";

const DEFAULT_CLIENT_INFO = { name: "aaw-desktop", version: "0.1.0" } as const;

// ---------------------------------------------------------------------------
// AcpSession
// ---------------------------------------------------------------------------

export class AcpSession implements AcpSessionPort {
  private loadingConfigurationSessionId: string | null = null;
  private latestConfigurationSessionId: string | null = null;
  private configurationGeneration = 0;
  private readonly configurationWaiters = new Set<(error: Error) => void>();
  private invalidateConfiguration(): void {
    this.configurationGeneration++;
    for (const reject of this.configurationWaiters)
      reject(new Error("配置确认已取消：连接或会话已改变"));
    this.configurationWaiters.clear();
  }
  private cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPrompts = 0;
  private readonly cancellationGraceMs: number | undefined;
  private readonly onCancellationTimeout?: () => Promise<unknown>;
  private clearCancellation(): void {
    clearTimeout(this.cancellationTimer);
    this.cancellationTimer = undefined;
  }
  private readonly connection: AcpSessionConnection;
  private closingSession?: Promise<void>;
  private invalidated = false;
  private readonly elicitationResponder: AcpSessionOptions["onElicitation"];
  private readonly forms = new Set<AbortController>();
  private invalidateForms(): void {
    for (const controller of this.forms) controller.abort();
  }
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>();
  private readonly permissionResponder: PermissionResponder | undefined;
  private readonly agentId: string | undefined;
  private readonly supportsCustomAnswers: AcpSessionOptions["supportsCustomAnswers"];
  private readonly dialect: AcpDialect | undefined;
  private readonly clientInfo: {
    readonly name: string;
    readonly version?: string;
  };
  /** 会话创建/恢复时下发的 MCP server 清单（缺省 []，ADR 024 §7 改动 1）。 */
  private readonly mcpServers: readonly McpServer[];

  /** 握手结果（initialize 成功后有效）。 */
  private handshake: InitializeResult | null = null;
  private sessionCwd: string | undefined;
  private sessionInfoRevision = 0;
  private promptRevision = 0;
  /** 当前（最近一次 new/load 的）会话 id。 */
  sessionId: string | null = null;
  /** 最近一次 new/load 返回的模型状态。 */
  configOptions: readonly SessionConfigOption[] = [];
  models: NewSessionResult["models"] = null;
  /** 最近一次 new/load 返回的模式状态。 */
  modes: NewSessionResult["modes"] = null;

  constructor(
    connection: AcpSessionConnection,
    options: AcpSessionOptions,
    private readonly releaseSession: () => void,
    private readonly logger = createLogger("acp"),
  ) {
    this.onCancellationTimeout = options.onCancellationTimeout;
    this.cancellationGraceMs = this.onCancellationTimeout
      ? options.cancellationGraceMs
      : undefined;
    this.elicitationResponder = options.onElicitation;
    this.connection = connection;
    this.permissionResponder = options.onPermissionRequest;
    this.agentId = options.agentId;
    this.supportsCustomAnswers = options.supportsCustomAnswers;
    this.dialect = options.dialect;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.mcpServers = options.mcpServers ?? [];
    this.connection.setNotificationHandler((method, params) => {
      this.dispatchNotification(method, params);
    });
    this.connection.setServerRequestHandler(async (method, params) =>
      this.handleServerRequest(method, params),
    );
  }

  invalidateConnection(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.listeners.clear();
    this.invalidateConfiguration();
    this.invalidateForms();
    this.clearCancellation();
  }

  /** Session-only release; transport ownership remains with the shared connection. */
  closeSession(): Promise<void> {
    return (this.closingSession ??= this.closeSessionOnly());
  }
  private async closeSessionOnly(): Promise<void> {
    this.invalidateConnection();
    try {
      if (this.sessionId !== null) {
        await this.connection.request(
          ACP_METHOD.sessionClose,
          { sessionId: this.sessionId },
          { timeoutMs: 15000 },
        );
        this.sessionId = null;
      }
    } finally {
      this.releaseSession();
    }
  }

  /** 订阅事件流，返回退订函数。 */
  onEvent(listener: (event: AcpSessionEvent) => void): () => void {
    if (this.invalidated) return () => {};
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
          ...(this.elicitationResponder ? { elicitation: { form: {} } } : {}),
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
    options: SessionSetupOptions = {},
  ): Promise<NewSessionResult> {
    this.invalidateConfiguration();
    this.latestConfigurationSessionId = null;
    const { mcpServers = this.mcpServers, ...requestOptions } = options;
    const raw = await this.connection.request(
      ACP_METHOD.sessionNew,
      { cwd, mcpServers },
      requestOptions,
    );
    const result = asNewSessionResult(raw);
    if (result === null) {
      throw new AcpHandshakeError(
        `session/new 响应形状不合法（缺少 sessionId）：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    this.sessionId = result.sessionId;
    this.sessionCwd = cwd;
    this.configOptions = Array.isArray(asRecord(raw)?.configOptions)
      ? parseConfigOptions(
          this.dialect?.normalizeConfigOptions?.(
            asRecord(raw)?.configOptions,
          ) ?? asRecord(raw)?.configOptions,
        )
      : this.latestConfigurationSessionId === result.sessionId
        ? this.configOptions
        : [];
    this.models = configModels(this.configOptions) ?? result.models;
    this.modes = configModes(this.configOptions) ?? result.modes;
    this.logger.info(`会话已建立 · sessionId ${result.sessionId.slice(0, 8)}…`);
    return { ...result, models: this.models, modes: this.modes };
  }

  /** 恢复已保存的会话（chrys 声明了 loadSession 能力）。 */
  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionSetupOptions = {},
  ): Promise<LoadSessionResult> {
    this.invalidateConfiguration();
    this.latestConfigurationSessionId = null;
    this.loadingConfigurationSessionId = sessionId;
    const { mcpServers = this.mcpServers, ...requestOptions } = options;
    const raw = await this.connection
      .request(
        ACP_METHOD.sessionLoad,
        { sessionId, cwd, mcpServers },
        requestOptions,
      )
      .finally(() => {
        this.loadingConfigurationSessionId = null;
      });
    const result = asLoadSessionResult(raw);
    if (result === null) {
      throw new AcpHandshakeError(
        `session/load 响应形状不合法：${JSON.stringify(raw)?.slice(0, 300)}`,
      );
    }
    this.sessionId = sessionId;
    this.sessionCwd = cwd;
    this.configOptions = Array.isArray(asRecord(raw)?.configOptions)
      ? parseConfigOptions(
          this.dialect?.normalizeConfigOptions?.(
            asRecord(raw)?.configOptions,
          ) ?? asRecord(raw)?.configOptions,
        )
      : this.latestConfigurationSessionId === sessionId
        ? this.configOptions
        : [];
    this.models = configModels(this.configOptions) ?? result.models;
    this.modes = configModes(this.configOptions) ?? result.modes;
    return { ...result, models: this.models, modes: this.modes };
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
    text: string | readonly ContentBlock[],
    options: { timeoutMs?: number } = {},
  ): Promise<PromptResult> {
    this.assertSession();
    const sessionId = this.sessionId!;
    const generation = this.configurationGeneration;
    const promptRevision = ++this.promptRevision;
    const blocks = typeof text === "string" ? [{ type: "text", text }] : text;
    this.pendingPrompts++;
    if (this.pendingPrompts === 1) {
      // 本地轮次开始（真实 pendingPrompts 状态发声）：任何驱动方（用户
      // 输入、工作流调度）一视同仁，会话视图运行态以它为准。
      this.emit({ type: "turn_started", sessionId });
    }
    let result: PromptResult | null = null;
    try {
      const raw = await this.connection
        .request(
          ACP_METHOD.sessionPrompt,
          { sessionId: this.sessionId, prompt: blocks },
          { timeoutMs: options.timeoutMs ?? null },
        )
        .finally(() => {
          this.invalidateForms();
        });
      result = asPromptResult(raw);
      if (result === null) {
        throw new AcpResponseError(
          ACP_METHOD.sessionPrompt,
          -32603,
          `响应形状不合法（stopReason 缺失或非法）：${JSON.stringify(raw)?.slice(0, 300)}`,
        );
      }
    } finally {
      this.pendingPrompts--;
      if (!this.pendingPrompts) {
        this.clearCancellation();
        // 本地轮次结束：stopReason 取自响应；失败（无响应）为 null——
        // 「取消绝不伪装成功」，结局语义由 store 的 endTurn 归约。
        this.emit({
          type: "turn_ended",
          sessionId,
          stopReason: result?.stopReason ?? null,
        });
      }
    }
    if (
      this.dialect?.refreshSessionInfoAfterPrompt &&
      asRecord(this.handshake?.agentCapabilities.sessionCapabilities)?.list
    ) {
      void this.refreshSessionInfo(sessionId, generation, promptRevision);
    }
    return result;
  }

  private async refreshSessionInfo(
    sessionId: string,
    generation: number,
    promptRevision: number,
  ): Promise<void> {
    const infoRevision = this.sessionInfoRevision;
    const current = () =>
      this.sessionId === sessionId &&
      this.configurationGeneration === generation &&
      this.promptRevision === promptRevision &&
      this.sessionInfoRevision === infoRevision;
    const seen = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 10 && current(); page++) {
        const result = await this.listSessions(this.sessionCwd, {
          cursor,
          timeoutMs: 2000,
        });
        if (!current()) return;
        const info = result.sessions.find(
          (entry) => entry.sessionId === sessionId,
        );
        if (info) {
          if (info.title?.trim())
            this.emit({
              type: "session_info_update",
              sessionId,
              title: info.title,
              ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
            });
          return;
        }
        cursor = result.nextCursor ?? undefined;
        if (!cursor || seen.has(cursor)) return;
        seen.add(cursor);
      }
    } catch (error) {
      this.logger.warn("刷新会话信息失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
    const grace = this.cancellationGraceMs;
    if (
      this.pendingPrompts &&
      grace !== undefined &&
      Number.isFinite(grace) &&
      grace > 0 &&
      !this.cancellationTimer
    ) {
      this.cancellationTimer = setTimeout(() => {
        this.cancellationTimer = undefined;
        if (!this.pendingPrompts) return;
        this.emit({
          type: "agent_warning",
          origin: "ACP",
          sessionId: this.sessionId,
          code: "cancel-force-stop",
          message:
            "取消未获确认，正在强制停止当前 Agent 进程；已执行操作的结果未知。",
        });
        const stoppedSessionId = this.sessionId;
        void this.onCancellationTimeout!()
          .then(() => {
            const message =
              "已强制停止当前 Agent 进程；已执行操作的结果未知，消息不会自动重发。";
            this.logger.warn(message, { sessionId: stoppedSessionId });
            this.emit({
              type: "agent_warning",
              origin: "ACP",
              sessionId: stoppedSessionId,
              code: "cancel-forced",
              message,
            });
          })
          .catch((error: unknown) => {
            const message = `强制停止失败：${String(error)}`;
            this.logger.error(message);
            this.emit({
              type: "agent_warning",
              origin: "ACP",
              sessionId: this.sessionId,
              code: "cancel-force-stop-failed",
              message,
            });
          });
      }, grace);
    }
  }

  /** 切换审批模式（manual / auto / bypass）。 */
  async setMode(
    modeId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.assertSession();
    await this.changeConfiguration("mode", modeId, options);
  }

  async setModel(
    modelId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.assertSession();
    await this.changeConfiguration("model", modelId, options);
  }

  /**
   * 客户端发起的 agent 私有扩展请求（`_` 前缀方法，如
   * `_session/switch_agent`）；通用逃生门，不进标准 ACP 方法面的
   * agent 私有请求从这里发出（ADR 024 §7 改动 2）。
   *
   * 约束：会话须已建立；method 必须以 `_` 开头；params 不得自带
   * sessionId（由本方法自动附上当前会话 id）。
   */
  async requestExtension(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    this.assertSession();
    if (!method.startsWith("_") || "sessionId" in params) {
      throw new Error(
        "extension method must start with _ and cannot override sessionId",
      );
    }
    return this.connection.request(
      method,
      { ...params, sessionId: this.sessionId },
      options,
    );
  }

  /** Optional acknowledgement policy; all vendor interpretation stays in the dialect. */
  private async changeConfiguration(
    category: "model" | "mode",
    value: string,
    options: { timeoutMs?: number },
  ): Promise<void> {
    const strict = this.dialect?.requireConfigurationConfirmation === true;
    const config = this.configOptions.find(
      (option) => option.category === category,
    );
    const available =
      category === "model"
        ? this.models?.availableModels.map((model) => model.modelId)
        : this.modes?.availableModes.map((mode) => mode.id);
    if (strict && !available?.includes(value))
      throw new Error("所选配置不在 Agent 公布的可选列表中");
    const sessionId = this.sessionId;
    let acknowledged = false;
    let done: (() => void) | undefined;
    let rejectWait: ((error: Error) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = this.onEvent((event) => {
      if (!strict || !("sessionId" in event) || event.sessionId !== sessionId)
        return;
      const matches =
        event.type === "config_options"
          ? event.configOptions.some(
              (option) =>
                option.category === category && option.currentValue === value,
            )
          : category === "mode" &&
            event.type === "current_mode_update" &&
            event.modeId === value;
      if (matches) {
        acknowledged = true;
        done?.();
      }
    });
    const current = () =>
      category === "model"
        ? this.models?.currentModelId
        : this.modes?.currentModeId;
    if (strict && current() === value) {
      unsubscribe();
      return;
    }
    const generation = this.configurationGeneration;
    try {
      let useLegacy = !config;
      if (config) {
        try {
          await this.setConfigOption(config.id, value, options);
        } catch (error) {
          if (
            strict &&
            error instanceof AcpResponseError &&
            error.jsonRpcCode === -32601
          )
            useLegacy = true;
          else throw error;
        }
      }
      if (useLegacy) {
        await this.connection.request(
          category === "model"
            ? ACP_METHOD.sessionSetModel
            : ACP_METHOD.sessionSetMode,
          {
            sessionId,
            ...(category === "model" ? { modelId: value } : { modeId: value }),
          },
          options,
        );
        if (!strict && category === "model" && this.models)
          this.models = { ...this.models, currentModelId: value };
      }
      if (strict && this.configurationGeneration !== generation)
        throw new Error("配置确认已取消：连接或会话已改变");
      if (strict && current() !== value) acknowledged = false;
      if (strict && !acknowledged) {
        await new Promise<void>((resolve, reject) => {
          done = resolve;
          rejectWait = reject;
          timer = setTimeout(
            () =>
              reject(new Error("Agent 未确认配置生效，请重新连接核对当前配置")),
            options.timeoutMs ?? 2000,
          );
          this.configurationWaiters.add(reject);
          if (this.configurationGeneration !== generation)
            reject(new Error("配置确认已取消：连接或会话已改变"));
        });
      }
      if (strict && current() !== value)
        throw new Error("Agent 当前配置与请求不一致，未确认切换成功");
    } finally {
      clearTimeout(timer);
      unsubscribe();
      if (rejectWait) this.configurationWaiters.delete(rejectWait);
    }
  }

  async setConfigOption(
    configId: string,
    value: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.assertSession();
    this.assertSession();
    const targetSessionId = this.sessionId;
    const generation = this.configurationGeneration;
    const raw = await this.connection.request(
      "session/set_config_option",
      { sessionId: targetSessionId, configId, value },
      options,
    );
    if (
      !Array.isArray(asRecord(raw)?.configOptions) &&
      !this.dialect?.requireConfigurationConfirmation
    )
      throw new AcpHandshakeError(
        "配置更新响应缺少 configOptions，无法确认更新结果",
      );
    if (
      generation !== this.configurationGeneration ||
      targetSessionId !== this.sessionId
    )
      throw new Error("配置响应已过期：会话已改变");
    if (!Array.isArray(asRecord(raw)?.configOptions)) return;
    const configOptions = parseConfigOptions(
      this.dialect?.normalizeConfigOptions?.(asRecord(raw)?.configOptions) ??
        asRecord(raw)?.configOptions,
    );
    this.emit({
      type: "config_options",
      sessionId: this.sessionId!,
      configOptions,
    });
  }

  // ------------------------------------------------------------- 通知派发

  private dispatchNotification(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    if (this.invalidated) return;
    const receivedAt = performance.now();
    try {
      const event = this.translateNotification(method, params);
      if (event !== null) {
        this.emit(
          method === "session/update" &&
            (event.type === "agent_message_chunk" ||
              event.type === "agent_thought_chunk") &&
            event.sessionId === this.sessionId
            ? { ...event, receivedAt }
            : event,
        );
        for (const derived of this.dialect?.deriveEvents?.(event) ?? [])
          this.emit(derived);
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
      const event = translateSessionUpdate(
        params,
        this.dialect?.normalizeConfigOptions,
      );
      return event ? (this.dialect?.enhanceEvent?.(event) ?? event) : null;
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
      const event = translateSessionUpdate(
        { ...params, update },
        this.dialect?.normalizeConfigOptions,
      );
      return event ? (this.dialect?.enhanceEvent?.(event) ?? event) : null;
    }
    // 3) 兜底：原样透传，不丢数据
    return { type: "unknown_notification", method, params };
  }

  private emit(event: AcpSessionEvent): void {
    if (this.invalidated) return;
    if (
      event.type === "session_info_update" &&
      event.sessionId === this.sessionId
    )
      this.sessionInfoRevision++;
    if (
      (event.type === "config_options" ||
        event.type === "current_mode_update") &&
      this.sessionId !== null &&
      event.sessionId !== this.sessionId &&
      event.sessionId !== this.loadingConfigurationSessionId
    )
      return;
    if (event.type === "config_options") {
      this.latestConfigurationSessionId = event.sessionId;
      this.configOptions = event.configOptions;
      this.models = configModels(this.configOptions) ?? this.models;
      this.modes = configModes(this.configOptions) ?? this.modes;
    }
    if (event.type === "current_mode_update") {
      const modeId = event.modeId;
      event = {
        ...event,
        name:
          this.modes?.availableModes.find((mode) => mode.id === modeId)?.name ??
          modeId,
      };
      if (this.modes)
        this.modes = { ...this.modes, currentModeId: event.modeId };
    }
    for (const listener of [...this.listeners]) {
      if (this.invalidated) break;
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
    if (method === "elicitation/create" && this.elicitationResponder) {
      const form = parseRuntimeElicitationForm(
        params,
        this.agentId,
        this.supportsCustomAnswers?.() === true,
      );
      if (!form) {
        this.logger.warn("拒绝不支持或无效的 ACP 表单", { mode: params.mode });
        return { action: "decline" };
      }
      const scope =
        form.requestId !== undefined
          ? this.connection.requestScope(form.requestId)
          : null;
      if (form.requestId !== undefined && !scope) return { action: "cancel" };
      if (
        form.sessionId !== undefined &&
        this.sessionId !== null &&
        form.sessionId !== this.sessionId
      )
        return { action: "cancel" };
      const controller = new AbortController();
      const abort = () => controller.abort();
      scope?.signal.addEventListener("abort", abort, { once: true });
      this.forms.add(controller);
      try {
        return await this.elicitationResponder(
          form,
          controller.signal,
          scope?.method,
        );
      } finally {
        scope?.signal.removeEventListener("abort", abort);
        this.forms.delete(controller);
      }
    }
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
      return {
        outcome:
          this.dialect?.normalizePermissionOutcome?.(outcome, params) ??
          outcome,
      };
    }
    // 未知反向请求：按 JSON-RPC method not found 报回
    throw new AcpMethodNotFoundError(method);
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
  normalizeConfigOptions?: (raw: unknown) => unknown,
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
      if (text.length === 0 && nonTextContent(update["content"]).length === 0) {
        return null;
      }
      const messageId = asString(update["messageId"]);
      return {
        type: kind,
        sessionId,
        text,
        content: update["content"],
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
      const toolKind = parseToolKind(update["kind"]);
      const status = asToolStatus(asString(update["status"]));
      return {
        type: kind,
        sessionId,
        toolCallId,
        ...(title === null ? {} : { title }),
        ...(toolKind === undefined ? {} : { kind: toolKind }),
        ...(status === null ? {} : { status }),
        ...("rawInput" in update ? { rawInput: update["rawInput"] } : {}),
        ...("rawOutput" in update ? { rawOutput: update["rawOutput"] } : {}),
        ...("content" in update ? { content: update["content"] } : {}),
        ...(Array.isArray(update["locations"])
          ? { locations: parseToolLocations(update["locations"]) }
          : {}),
        ...(asRecord(update["_meta"])
          ? { _meta: asRecord(update["_meta"])! }
          : {}),
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
    case "config_option_update":
      return {
        type: "config_options",
        sessionId,
        configOptions: parseConfigOptions(
          normalizeConfigOptions?.(update["configOptions"]) ??
            update["configOptions"],
        ),
      };
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
  const modelId = asString(record["modelId"]);
  const model = modelId ? { modelId } : {};
  const usageRecord = asRecord(record["usage"]);
  if (usageRecord === null) {
    return { stopReason, ...model };
  }
  const inputTokens = asNumber(usageRecord["inputTokens"]);
  const outputTokens = asNumber(usageRecord["outputTokens"]);
  const totalTokens = asNumber(usageRecord["totalTokens"]);
  if ([inputTokens, outputTokens, totalTokens].some((n) => n === null || !Number.isFinite(n) || n < 0)) return { stopReason, ...model };
  const cachedReadTokens = asNumber(usageRecord["cachedReadTokens"]);
  return {
    stopReason,
    ...model,
    usage: {
      inputTokens: inputTokens!,
      outputTokens: outputTokens!,
      totalTokens: totalTokens!,
      ...(cachedReadTokens === null ? {} : { cachedReadTokens }),
    },
  };
}

// ---------------------------------------------------------------------------
// 基础守卫（实现移至 parse.ts，供各 agent 方言共用）
// ---------------------------------------------------------------------------

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
