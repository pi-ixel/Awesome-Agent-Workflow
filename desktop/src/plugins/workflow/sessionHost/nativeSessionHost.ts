/**
 * ADR 023 二期-1（§9 第 1、6 条）：Desktop 原生会话宿主；二期-2（§9 第
 * 2、3 条）消息原生化 + 反向请求直通 → ADR 024 §5 ②（Cordis 插件移植）。
 *
 * 移植自 src/workflow/nativeHost/nativeSessionHost.ts（commit 24877d9，
 * 846 行）。8 帧分发、tracker 幂等、队列与 pendingWait、事件投影
 * emitSessionCreated 等逻辑逐行保留；适配点（见各处标注）：
 *
 * 1. `import { AcpSession } from "../../acp/session.ts"` 改为远端共享协议
 *    会话类 `../../plugins/acpRuntime/service.ts` 公开出口的 `AcpSession`
 *    ——构造签名从 (transport, options) 变为 (connection, options, release)，
 *    经 openAcpTransport 注入的 JsonRpcConnection 装配。MCP 清单 = 需求单
 *    mcp_servers（标准元素）+ 结果通道（ADR 024 §9-3：握手后按 Agent 声明
 *    的 mcpCapabilities 经 resultChannel.ts 唯一规则选定 stdio/HTTP），
 *    经 newSession/loadSession 的调用级 mcpServers 下发。
 * 2. `requestExtension`：底座已补该方法（ADR 024 §7 改动 2），profile
 *    非空的新会话按原实现执行 `_session/switch_agent` 并核验 toProfile。
 * 3. AcpSession.close 的形状变化：远端类无 close({closeTimeoutMs})/kill()，
 *    只有 closeSession()（session-only）——进程收口由宿主对 transport 的
 *    close/kill 承担（顺序：先 session/close 再进程收口，语义与原实现
 *    一致）。
 * 4. 装配参数从「读全局 store」（useSettingsStore / useWorkspaceStore /
 *    settingsLinks）改为构造注入（NativeHostDeps）：审批模式分派、方言
 *    工厂、agent 启动描述都由插件 index.ts 以 agents/project 服务装配。
 * 5. workflowService（模块单例）改为构造注入的 WorkflowClient。
 *
 * 引擎（workflow_service.exe）以 `--session-host native` 装配 RemoteHost：
 * `SessionHost` 的每个 hook 都变成一条 NDJSON 宿主回调帧（引擎 stdout 的
 * `{"type":"host-frame","frame":…}` 行），等待同一关联 id 的应答帧。本模块
 * 是帧的对端，接缝收口为**轮次边界**：
 *
 * - **spawn_node_session**（引擎→Desktop）：按需求单（信封：动作身份 +
 *   cwd/command/profile/MCP 清单/恢复 id）用 Desktop 原生 ACP 客户端拉起
 *   节点 Agent——spawn 进程、initialize 握手、new/load session、profile
 *   切换，全部走生产路径（host.acpProcess + AcpSession）；成功后经
 *   nativeBridge 投影 `acp-session-created` 进正常会话体系。应答 `{sessionId}`。
 * - **prompt_turn**：向会话送入引擎渲染的调度轮次（调度文本不含用户会话
 *   内容）；投影 `workflow_context` 会话身份标注（普通呈现）。ACP 轮次
 *   结束（prompt 响应返回）即 **turn_ended**——以应答帧回给引擎，引擎此刻
 *   核验结果通道并决定推进/停摆。
 * - **wait_turn_ended**：引擎无结果时的轮次边界等待。本宿主持有该会话的
 *   用户消息队列（排队/送达语义原生自担，引擎不感知）：队列非空立即驱动
 *   消息轮次（消息以普通用户消息事件进入会话流，prompt 结束才应答 wait
 *   帧）；队列空则挂起并投影等待输入呈现，等用户经原生会话流补充消息。
 *   cancel_waiting 以 RUN_CANCELLED 应答唤醒。
 * - **enqueue_user_message**：入队（未知会话显式报错，绝不静默吞消息）。
 *   linkedRuntime 经 nativeBridge 直接调本队列（消息不过引擎协议）。
 * - **permission/question 反向请求**：AcpSession 的反向请求回调直答——
 *   自动放行按审批默认模式分派，人工卡挂到链接会话的 approvalStore，
 *   用户决定的 Promise 直接回给 ACP 连接，不经引擎转发。
 * - **stop_node_session / cancel_waiting**：原生 cancel / 进程树终止。
 * - **start_question_tracker / question_tracker_request**（二期-3）：问题池
 *   tracker 归宿主 spawn——需求单带启动参数（路径/cwd/home/runId 作用域），
 *   本模块按它拉起 tracker 进程并中继引擎的 JSON-RPC（trackerRelay.ts）。
 *
 * 「引擎只穿信封」的边界在这里守住：本模块消费需求单（身份+配置），把
 * 会话事件、消息内容与交互决定全部留给 Desktop 自己的会话体系；引擎侧只
 * 看到 sessionId 与轮次边界信号，看不到任何会话内容。
 */
import { withWorkflowInstruction } from "../../../shared/workflowInstruction.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import type { WorkflowClient } from "../engine/client.ts";
import type {
  HostRequestFrame,
  PendingHostWait,
  ResultChannelOfferWire,
  SpawnRequirementWire,
  WorkflowActionWire,
  TrackerStartParamsWire,
  WorkflowEvent,
} from "../engine/protocol.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { McpServer } from "../../../contracts/acp/protocol.ts";
import type { SessionSetupOptions } from "../../acpRuntime/types.ts";
import {
  agentSupportsHttpMcp,
  asResultChannelOffer,
  resultChannelServer,
  standardMcpServers,
} from "./resultChannel.ts";
import type { AcpDialect } from "../../acpRuntime/types.ts";
import type {
  NativeBridgeHub,
  ChrysQuestion,
  ChrysRequestInputResult,
} from "./nativeBridge.ts";
import {
  TrackerRelay,
  type TrackerTransport,
} from "./trackerRelay.ts";

/** 宿主回调帧里的文本字段：不是字符串时当作空串（不把对象字符串化成 [object Object]）。 */
const frameText = (value: unknown): string => (typeof value === "string" ? value : "");

/** 宿主装配依赖（原实现读全局 store / 模块单例的面，全部构造注入）。 */
export interface NativeHostDeps {
  /** 引擎服务客户端（宿主应答帧与 host-frame 订阅的通道）。 */
  readonly workflow: Pick<WorkflowClient, "subscribe" | "respondHostFrame">;
  /** nativeBridge 单例（消息队列 / 直答 UI / 事件投影的登记处）。 */
  readonly bridge: NativeBridgeHub;
  /**
   * 会话收养端口（ADR 024 §9 开放问题 1）：节点会话经 project 的
   * adoptExternalSession 登记进标准会话体系（侧栏 + SessionView + 同一套
   * 审批/投影）。收养失败显式报错——绝不降级为孤儿会话。
   */
  readonly adoptSession: (options: {
    readonly runId: string;
    readonly workspacePath: string;
    readonly command: readonly string[];
    /** 节点的角色（ADR 036）：按角色指定 Agent 时据此找到这次运行记下的 Agent。 */
    readonly role?: string;
    readonly resumeSessionId: string | null;
    readonly title?: string;
    readonly onUserMessage: (sessionId: string, text: string) => Promise<void>;
    readonly create: (
      sessionOptions: AdoptSessionOptions,
      context: { readonly agentKey: string; readonly agentId?: string },
    ) => Promise<AcpSessionPortLike>;
  }) => Promise<{ readonly sessionId: string }>;
  /**
   * 共享池会话面（acpRuntime.protocol.open 的白名单出口）：节点会话与
   * 用户会话同池调度。open 回调按 sessionOptions 建会话（不 initialize），
   * 握手由 create 剩余步骤完成。返回 AcpSessionPort（收养方按端口面
   * 消费；具体类归 acpRuntime）。
   */
  readonly openAgentsSession: (options: {
    readonly sessionOptions: AdoptSessionOptions;
    readonly clientInfo: { readonly name: string; readonly version: string };
    readonly dialect: AcpDialect | undefined;
    readonly agentId?: string;
  }) => AcpSessionPortLike | Promise<AcpSessionPortLike>;
  /** 共享池会话的释放面（acpRuntime.protocol.release 白名单出口）：节点
   * 会话收口 / spawn 失败清理都走这里——连接归池，不 kill 池化进程。 */
  readonly releaseAgentsSession: (session: AcpSessionPortLike) => Promise<void>;
  /** 问题池 tracker 的进程工厂（二期-3；生产走 host.acpProcess）。 */
  readonly openTrackerTransport?: (
    params: TrackerStartParamsWire,
  ) => Promise<TrackerTransport>;
}

/** 收养回传给 project.create 的会话选项：project 以 AcpProtocolSessionOptions
 * 形状注入标准会话回调（审批/表单/问答/连接失败），本类型是它在工作流
 * 插件侧的形状描述——回调入参用 unknown 收窄再转交，不引入 project 内部
 * 类型（跨插件边界只经 service.ts 的公开面）。 */
export type AdoptSessionOptions = {
  readonly background?: boolean;
  readonly onConnectionFailure?: (reason: string) => void;
  readonly onElicitation: (
    form: unknown,
    signal: AbortSignal,
    scopeMethod?: string,
  ) => Promise<unknown>;
  readonly onQuestion: (
    sessionId: string,
    requestId: string,
    questions: readonly unknown[],
    callerName: string | null,
  ) => Promise<unknown>;
  readonly onPermissionRequest: (
    sessionId: string,
    toolCall: Readonly<Record<string, unknown>>,
    options: readonly unknown[],
  ) => Promise<unknown>;
  readonly mcpServers?: readonly McpServer[];
};

/**
 * 节点会话的端口面（AcpSession 的结构子集）：本模块按它消费协议调用
 * （initialize/new/load/prompt/close/requestExtension/onEvent），具体类
 * 仍归 acpRuntime（AcpSession 是端口的结构超集，赋值方向安全）。
 */
export interface AcpSessionPortLike {
  readonly sessionId: string | null;
  initialize(options?: { timeoutMs?: number }): Promise<unknown>;
  newSession(cwd: string, options?: SessionSetupOptions): Promise<unknown>;
  loadSession(sessionId: string, cwd: string, options?: SessionSetupOptions): Promise<unknown>;
  prompt(text: string, options?: { timeoutMs?: number; echo?: "workflow" }): Promise<{ stopReason: string }>;
  cancel(): void;
  requestExtension(method: string, params?: Readonly<Record<string, unknown>>, options?: { timeoutMs?: number }): Promise<unknown>;
  onEvent(listener: (event: AcpSessionEvent) => void): () => void;
  closeSession(): Promise<void>;
  /** 会话可选的模型（新建会话时由 Agent 给出；没给时为空）。 */
  readonly models?: { readonly availableModels: readonly { readonly modelId: string }[] } | null;
  setModel?(modelId: string): Promise<void>;
}

/** nativeHost 的呈报回调（测试注入桩；生产接线见 createProductionCallbacks）。 */
export interface NativeHostCallbacks {
  /** agent 方言挂接（私有反向请求 _chrys/request_input 的直答面）。 */
  readonly createDialect?: () => AcpDialect | undefined;
}


/** wait_turn_ended 帧挂起等待的标记：应答由消息轮次完成/取消时发出。 */
const DEFERRED_RESPONSE = Symbol("deferred-response");

/** 一条被托管的原生会话：ACP 连接 + 该会话的簿记（消息队列与轮次状态）。 */
interface NativeSession {
  readonly session: AcpSessionPortLike;
  /** 收口入口：session/close（连接归共享池，不 kill 池化 transport）。 */
  readonly close: () => Promise<void>;
  readonly profile: string | null;
  requirement: SpawnRequirementWire;
  readonly runId: string;
  /** 排队中的用户补充消息（原生队列；引擎侧没有任何队列形态）。 */
  readonly queue: string[];
  /** 挂起的 wait_turn_ended 帧（引擎在等下一个轮次边界）：关联 id 在帧
   * 信封上（HostFrame 的顶层 id），挂起时一并保存。 */
  pendingWait: PendingHostWait | null;
  /** 已公告等待输入（每次等待只公告一次）。 */
  waitingNotified: boolean;
  /** 一次 ACP prompt 进行中（引擎调度轮次或原生消息轮次）。 */
  busy: boolean;
}

/**
 * Desktop 原生会话宿主。订阅工作流服务的 `host-frame` 事件，按帧驱动
 * 原生 ACP 会话，以同 id 应答帧回给引擎。
 */
export class NativeSessionHost {
  private readonly sessions = new Map<string, NativeSession>();
  private readonly callbacks: NativeHostCallbacks;
  private readonly deps: NativeHostDeps;
  private readonly logger: Logger;
  /** 问题池 tracker（runId → 连接）：宿主 spawn 并持有，运行收口时终止。 */
  private readonly trackers = new Map<string, TrackerRelay>();
  /** spawn/握手请求的会话级超时（ms）：realRuntime 用 30s（真实 agent 冷
   * 启动实测 2-20s）；可注入以适配测试（无对端的 transport 走失败路径）。 */
  private handshakeTimeoutMs = 30_000;

  /** 构造后回填（attach 工厂与测试装配共用）。 */
  configure(options: { handshakeTimeoutMs?: number } = {}): void {
    if (options.handshakeTimeoutMs !== undefined) {
      this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    }
  }

  /** 供测试观测：当前托管的会话 id 集合。 */
  hostedSessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  private constructor(
    deps: NativeHostDeps,
    callbacks: NativeHostCallbacks,
    logger: Logger,
  ) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.logger = logger;
  }

/** 创建并装配：订阅事件泵，开始承接引擎的宿主回调帧。返回解挂函数。
 * 返回值的 `host` 字段是宿主实例（诊断/测试观测用；生产方只用解挂函数）。
 *
 * 线格式（与引擎 remote_host.rs / bin 的信封约定一一对应）：
 * - 引擎→Desktop：事件信封行 `{"type":"event","event":{"type":"host-frame",
 *   "runId":…,"frame":"<RemoteHost 线帧 JSON 字符串>"}}`——事件泵把 event
 *   对象投给 observers，本模块解出 runId 与 frame 字符串；
 * - Desktop→引擎：`workflow_service_host_frame_response` 命令，frame 以
 *   **字符串**回传（引擎 `message["frame"].as_str()` 解码），runId 带回。 */
static attach(
  deps: NativeHostDeps,
  callbacks: NativeHostCallbacks,
  options: { handshakeTimeoutMs?: number; logger?: Logger } = {},
): { host: NativeSessionHost; detach: () => void } {
  const logger = options.logger ?? createLogger("workflow-native-host");
  const host = new NativeSessionHost(deps, callbacks, logger);
  host.configure(options);
  const unsubscribe = deps.workflow.subscribe((event: WorkflowEvent) => {
    if (event.type !== "host-frame") {
      return;
    }
    const runId = typeof event.runId === "string" ? event.runId : null;
    const rawFrame = event.frame;
    // frame 是 RemoteHost 线帧的 JSON 字符串（remote_host.rs HostFrame：
    // `{"id","request":{…}}`）；对象形状只可能是同进程内测试直喂（容忍），
    // 线上两端都用字符串。
    let frame: { id: number; request: HostRequestFrame } | null = null;
    if (typeof rawFrame === "string") {
      try {
        frame = unwrapEngineFrame(JSON.parse(rawFrame));
      } catch {
        frame = null;
      }
    } else if (rawFrame !== null && typeof rawFrame === "object") {
      frame = unwrapEngineFrame(rawFrame);
    }
    if (runId === null || frame === null) {
      logger.warn("宿主回调帧信封不完整，丢弃", {
        hasRunId: runId !== null,
        frameKind: typeof rawFrame,
      });
      return;
    }
    host.handleFrame(runId, frame.id, frame.request).catch((error) => {
      logger.warn("宿主回调帧处理失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });
  // 消息队列能力注册进 nativeBridge：adoptExternalSession 的 onUserMessage
  // 把用户补充消息路由进原生会话流（不经过引擎协议，轮次边界送达）。
  deps.bridge.registerNativeMessageQueue({
    hosted: (sessionId) => host.sessions.has(sessionId),
    queue: (sessionId, text) => host.queueUserMessage(sessionId, text),
  });
  return {
    host,
    detach: () => {
      unsubscribe();
      deps.bridge.registerNativeMessageQueue(null);
      void host.closeAll();
    },
  };
}

  /** 全部会话收口（解挂 / 测试收尾）：session/close（连接归共享池，收养
   * 语义——不 kill 池化 transport，tracker 随运行收口一并终止）。 */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    const trackers = [...this.trackers.values()];
    this.trackers.clear();
    await Promise.all([
      ...all.map(async ({ session, close }) => {
        try {
          await session.closeSession();
        } catch {
          /* close 兜底收口 */
        }
        await close().catch(() => undefined);
      }),
      ...trackers.map((relay) =>
        relay.close().catch(() => undefined),
      ),
    ]);
  }

  private async handleFrame(runId: string, id: number, frame: HostRequestFrame): Promise<void> {
    // cancel_waiting 是 fire-and-forget（引擎侧只发不等应答）：回应答帧会
    // 在引擎 mailbox 里变成无主帧，下一个请求先取到它就报 id 错配——
    // 停止中的轮次会被打成伪失败。本帧只执行唤醒（挂起的 wait 帧以
    // RUN_CANCELLED 应答唤醒），不回帧。
    if (frame.kind === "cancel_waiting") {
      await this.cancelWaiting(runId).catch((error) => {
        this.logger.warn("cancel_waiting 唤醒失败", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    const started = performance.now();
    try {
      const result = await this.dispatch(runId, frame, id);
      // 挂起的 wait 帧不在此处应答：消息轮次完成/取消时按同一关联 id
      // 应答（deferred 语义）。
      if (result === DEFERRED_RESPONSE) {
        return;
      }
      // 线格式：应答帧与请求帧同形（JSON 字符串），引擎 as_str() 解码。
      await this.respondHostFrame(runId, id, { result: result ?? null });
      this.logger.debug("宿主回调帧已应答", {
        kind: frame.kind,
        id,
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      await this.respondHostFrameError(runId, id, code);
      this.logger.warn("宿主回调帧应答失败", { kind: frame.kind, id, reason: code });
    }
  }

  private async dispatch(
    runId: string,
    frame: HostRequestFrame,
    id: number,
  ): Promise<unknown> {
    switch (frame.kind) {
      case "spawn_node_session":
        return this.spawnNodeSession(runId, frame.requirement as SpawnRequirementWire);
      case "prompt_turn":
        return this.promptTurn(
          String(frame.session_id),
          frameText(frame.prompt),
          frame.action,
        );
      case "wait_turn_ended":
        return this.waitTurnEnded(String(frame.session_id), id);
      case "stop_node_session":
        return this.stopNodeSession(String(frame.session_id));
      case "enqueue_user_message":
        // ⚠ 活引信（见 engine/protocol.ts 顶部说明）：用户消息原文过引擎
        // 线的唯一帧型。当前装配无生产触发方（面板只读，交互卡待批次二）；
        // 分发路径仅为与引擎 remote_host.rs 的线格式全集对齐而保留，批次二
        // 接线交互卡或显式注销。新代码不得主动触发。
        await this.queueUserMessage(
          String(frame.session_id),
          frameText(frame.text),
        );
        return null;
      case "start_question_tracker":
        // 二期-3：按需求单参数拉起 tracker（幂等）；载荷即 TrackerStartParams。
        await this.ensureTracker(runId, frame.params as TrackerStartParamsWire);
        return null;
      case "question_tracker_request": {
        const relay = this.trackers.get(runId);
        if (relay === undefined) {
          throw new Error("QUESTION_TRACKER_NOT_STARTED");
        }
        return relay.request(frameText(frame.method), frame.params ?? null);
      }
      default:
        throw new Error(`UNKNOWN_HOST_REQUEST:${frame.kind}`);
    }
  }

  /**
   * 按需求单参数确保 tracker 已 spawn 并完成运行作用域握手（幂等，同
   * runId 重复启动是 no-op）。spawn_node_session 携带 tracker 参数时也
   * 走这里——宿主对接缝的承诺是「进程归宿主」，引擎侧无需知道细节。
   */
  private async ensureTracker(
    runId: string,
    params: TrackerStartParamsWire,
  ): Promise<void> {
    if (this.trackers.has(runId)) {
      return;
    }
    if (
      params === null ||
      typeof params !== "object" ||
      typeof params.session !== "string" ||
      params.session.length === 0
    ) {
      throw new Error("QUESTION_POOL_SPAWN_FAILED");
    }
    const factory = this.deps.openTrackerTransport;
    if (factory === undefined) {
      throw new Error("QUESTION_TRACKER_TRANSPORT_UNAVAILABLE");
    }
    const transport = await factory(params);
    const relay = new TrackerRelay(transport);
    try {
      await relay.handshake(params.session);
    } catch (error) {
      await transport.kill().catch(() => undefined);
      throw error;
    }
    this.trackers.set(runId, relay);
  }

  // ------------------------------------------------------------- 投影

  /** 原生会话事件投影：与 headless 宿主的 acp-event 信封形状一致，走
   * linkedRuntime 同一条投影管线（普通会话体系零分叉）。 */
  private emitSessionEvent(native: NativeSession, event: Record<string, unknown>): void {
    this.deps.bridge.projectNativeEvent({
      type: "acp-event",
      runId: native.runId,
      actor: actorRefOf(native.requirement),
      instance: {
        siteId: native.requirement.action.site,
        ordinal: native.requirement.action.ordinal,
      },
      event,
    });
  }

  /** 一个动作的标准轮次开始：记录会话身份标注（普通呈现；不冒充用户）。 */
  private emitTurnContext(native: NativeSession, sessionId: string, prompt: string): void {
    const action = native.requirement.action;
    if ((action.input as { __initial?: unknown } | null)?.__initial === true) {
      const requirement = initialRequirementTextOf(action.input);
      if (requirement !== null) {
        this.emitSessionEvent(native, {
          type: "user_message_chunk",
          sessionId,
          text: requirement,
        });
      }
    }
    this.emitSessionEvent(native, {
      type: "workflow_context",
      sessionId,
      actor: actorNameOf(native.requirement),
      text: prompt,
    });
  }

  private emitSessionCreated(native: NativeSession, sessionId: string, restored: boolean): void {
    this.deps.bridge.projectNativeEvent({
      type: restored ? "acp-session-restored" : "acp-session-created",
      runId: native.runId,
      actor: actorRefOf(native.requirement),
      sessionId,
      persona: personaOf(native.requirement),
    });
  }

  // ------------------------------------------------------------- spawn

  /**
   * spawn_node_session：节点会话经 project.sessions.adoptExternalSession
   * 走共享池拉起并收养进标准会话体系（ADR 024 §9 开放问题 1）。project
   * 提供标准会话回调（审批/表单/问答/投影），本方在 create 回调里完成
   * 握手（initialize → new/load → profile 切换）——与 realRuntime 同一条
   * acpRuntime 池化路径，cwd/mcpServers 是会话级参数（new/load params）。
   * permission/question 反向请求由收养的 SessionView 直答（不经引擎）。
   */
  private async spawnNodeSession(
    runId: string,
    requirement: SpawnRequirementWire,
  ): Promise<{ sessionId: string }> {
    if (!requirement || typeof requirement.cwd !== "string" || requirement.cwd.length === 0) {
      throw new Error("ACP_PROCESS_CONFIGURATION_INVALID");
    }
    // 二期-3：需求单带 tracker 启动参数时，宿主先确保 tracker 在位
    // （幂等；引擎打开运行时也经 start_question_tracker 帧拉起，这里兜
    // 需求单信封的自足性——ADR §4「宿主负责 spawn」）。
    if (requirement.question_tracker !== null && requirement.question_tracker !== undefined) {
      await this.ensureTracker(runId, requirement.question_tracker);
    }
    const resumeId = requirement.resume_session_id ?? null;
    const callerMcpServers = standardMcpServers(requirement.mcp_servers);
    // 结果通道是节点交付的硬前提：需求单带了提供却解析不出，显式失败。
    const resultChannel =
      requirement.result_channel === null || requirement.result_channel === undefined
        ? null
        : asResultChannelOffer(requirement.result_channel);
    if (requirement.result_channel != null && resultChannel === null) {
      throw new Error("RESULT_CHANNEL_OFFER_INVALID");
    }
    const dialect = this.callbacks.createDialect?.();
    // create 闭包持有的会话句柄经闭包变量回传（adoptSession 只返回登记
    // 结果；TS 无法跨回调推断），adoptSession 成功后 opened 必非空。
    let opened: { session: AcpSessionPortLike; close: () => Promise<void> } | null =
      null;
    const handle: { session: AcpSessionPortLike; close: () => Promise<void> } =
      await new Promise((resolve, reject) => {
        void this.deps
          .adoptSession({
            runId,
            workspacePath: requirement.cwd,
            command: requirement.command,
            role: requirement.action.actor,
            resumeSessionId: resumeId,
            title: personaOf(requirement),
            onUserMessage: (sessionId, text) =>
              this.queueUserMessage(sessionId, text),
            create: async (sessionOptions, context) => {
              // 需求单信封的 MCP 清单透传（ADR 024 §7 改动 1 已落底座）：
              // new/load 均按此下发；结果通道 MCP 挂载的使能项（§9-3）。
              const result = await openAdoptedSession({
                sessionOptions,
                callerMcpServers,
                resultChannel,
                dialect,
                clientInfo: { name: "aaw-desktop-workflow", version: "0.1.0" },
                resumeId,
                cwd: requirement.cwd,
                model: requirement.model ?? null,
                profile: requirement.profile ?? null,
                handshakeTimeoutMs: this.handshakeTimeoutMs,
                agentsOpen: this.deps.openAgentsSession,
                agentId: context.agentId,
                release: (port) => this.deps.releaseAgentsSession(port),
              });
              if (result.session.sessionId === null) {
                throw new Error("ACP_SESSION_ID_MISSING");
              }
              opened = result;
              // 返回真端口：project 收养方要挂事件投影（acp.onEvent），
              // 降格成 {sessionId, close} 会在 attachSessionViews 处
              // TypeError（真机复盘 2026-11-11）。
              return result.session;
            },
          })
          .then(
            () => {
              if (opened !== null) resolve(opened);
              else reject(new Error("ACP_SESSION_ID_MISSING"));
            },
            (error: unknown) => {
              // 收养失败（含 create 返回后的登记失败）：不留半条连接。
              void opened?.close().catch(() => undefined);
              reject(error instanceof Error ? error : new Error(typeof error === "string" ? error : "ACP_ADOPTION_FAILED"));
            },
          );
      });
    const session = handle.session;
    const sessionId = session.sessionId;
    if (sessionId === null) {
      throw new Error("ACP_SESSION_ID_MISSING");
    }
    const native: NativeSession = {
      session,
      close: () => handle.close(),
      profile: requirement.profile ?? null,
      requirement,
      runId,
      queue: [],
      pendingWait: null,
      waitingNotified: false,
      busy: false,
    };
    // 原生事件投影进正常会话体系（引擎侧没有事件缓冲，投影职责归宿主）；
    // 收养后 SessionView 也直接消费 AcpSession 事件流——两条消费互不影响。
    session.onEvent((event) => this.forwardSessionEvent(native, sessionId, event));
    this.sessions.set(sessionId, native);
    this.emitSessionCreated(native, sessionId, resumeId !== null);
    this.logger.info("工作流节点会话已收养进标准会话体系", {
      sessionId,
      actor: requirement.action.actor,
      site: `${requirement.action.site}#${requirement.action.ordinal}`,
      restored: resumeId !== null,
    });
    return { sessionId };
  }

  /** ACP 会话事件 → 投影（native 会话的事件流直达链接会话视图）。 */
  private forwardSessionEvent(
    native: NativeSession,
    sessionId: string,
    event: AcpSessionEvent,
  ): void {
    this.emitSessionEvent(native, { ...(event as Record<string, unknown>), sessionId });
  }

  // ------------------------------------------------------------- 轮次

  /**
   * prompt_turn：送入引擎渲染的调度轮次。ACP prompt 的响应返回即本轮
   * 结束（turn_ended 的 Desktop 半边）；stopReason 非 end_turn 视为轮次
   * 未完成（与引擎 acp.rs 的语义一致：取消/连接丢失绝不能伪装成功）。
   * 运行态的发声归协议层（AcpSession 的 turn_started/turn_ended，真实
   * pendingPrompts 状态）——本模块不再投影轮次信号。
   */
  private async promptTurn(sessionId: string, prompt: string, action: unknown): Promise<null> {
    const native = this.sessions.get(sessionId);
    if (native === undefined) {
      throw new Error("WORKFLOW_SESSION_NOT_HOSTED");
    }
    if (typeof action !== "object" || action === null ||
      typeof (action as WorkflowActionWire).site !== "string" ||
      typeof (action as WorkflowActionWire).ordinal !== "number" ||
      typeof (action as WorkflowActionWire).actor !== "string") {
      throw new Error("WORKFLOW_ACTION_INVALID");
    }
    native.requirement = { ...native.requirement, action: action as WorkflowActionWire };
    this.emitTurnContext(native, sessionId, prompt);
    native.busy = true;
    try {
      // 这一轮的任务说明进会话（收成一行「工作流给 Agent 的说明」，并且新起一轮，计时从这轮开始）。
      const result = await native.session.prompt(withWorkflowInstruction(prompt), { echo: "workflow" });
      if (result.stopReason !== "end_turn") {
        throw new Error("ACP_TURN_NOT_COMPLETED");
      }
      return null;
    } finally {
      native.busy = false;
    }
  }

  /**
   * wait_turn_ended：引擎无结果时的轮次边界等待。队列非空立即驱动消息
   * 轮次（结束时应答本帧）；队列空则挂起并公告等待输入，等用户经原生
   * 会话流补充消息后由 queueUserMessage 驱动。
   */
  private async waitTurnEnded(sessionId: string, id: number): Promise<unknown> {
    const native = this.sessions.get(sessionId);
    if (native === undefined) {
      throw new Error("WORKFLOW_SESSION_NOT_HOSTED");
    }
    if (native.pendingWait !== null) {
      throw new Error("WORKFLOW_WAIT_ALREADY_PENDING");
    }
    native.pendingWait = { id, sessionId };
    if (native.queue.length > 0 && !native.busy) {
      await this.driveQueuedMessageTurn(native);
      return DEFERRED_RESPONSE;
    }
    if (!native.waitingNotified) {
      native.waitingNotified = true;
      this.emitSessionEvent(native, { type: "workflow_waiting_input", sessionId });
    }
    return DEFERRED_RESPONSE;
  }

  /** 消息轮次：队列头部消息进入会话流（普通用户消息事件呈现），ACP 轮
   * 次结束后按挂起 wait 帧的关联 id 应答（引擎只收 turn_ended）。 */
  private async driveQueuedMessageTurn(native: NativeSession): Promise<void> {
    const pending = native.pendingWait;
    if (pending === null) {
      return;
    }
    const sessionId = native.session.sessionId;
    if (sessionId === null) {
      return;
    }
    const text = native.queue.shift();
    if (text === undefined) {
      return;
    }
    native.waitingNotified = false;
    this.emitSessionEvent(native, {
      type: "user_message_chunk",
      sessionId,
      text,
    });
    native.busy = true;
    let failure: string | null = null;
    try {
      const result = await native.session.prompt(text);
      if (result.stopReason !== "end_turn") {
        throw new Error("ACP_TURN_NOT_COMPLETED");
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    native.busy = false;
    // cancel_waiting 可能已并发清掉了挂起帧（并回过 RUN_CANCELLED）：
    // 同一关联 id 绝不重复应答。
    if (native.pendingWait !== pending) {
      return;
    }
    native.pendingWait = null;
    if (failure !== null) {
      await this.respondHostFrameError(native.runId, pending.id, failure);
      return;
    }
    await this.respondHostFrame(native.runId, pending.id, { result: null });
  }

  // ------------------------------------------------------------- 消息队列

  /** 用户补充消息入队（原生队列；引擎侧没有消息形态）。已知会话且入口
   * 开放才接受；排队后若引擎正在等待轮次边界，立即驱动消息轮次。 */
  private async queueUserMessage(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || text.length > 1024 * 1024) {
      throw new Error("INVALID_USER_MESSAGE");
    }
    const native = this.sessions.get(sessionId);
    if (native === undefined) {
      throw new Error("WORKFLOW_SESSION_NOT_ACCEPTING_INPUT");
    }
    native.queue.push(text);
    this.logger.info("用户补充消息已进原生队列", {
      sessionId,
      queued: native.queue.length,
    });
    if (native.pendingWait !== null && !native.busy) {
      await this.driveQueuedMessageTurn(native);
    }
  }

  // ------------------------------------------------------------- 停止

  /**
   * cancel_waiting（停止运行 / 服务收尾，按帧信封的 runId 圈定范围）：
   * 清空队列、以 RUN_CANCELLED 应答挂起的 wait 帧、取消进行中的轮次。
   * 本帧自身不回帧（fire-and-forget）。
   */
  private async cancelWaiting(runId: string): Promise<void> {
    for (const native of this.sessions.values()) {
      if (native.runId !== runId) {
        continue;
      }
      native.queue.length = 0;
      const pendingWait = native.pendingWait;
      native.pendingWait = null;
      if (pendingWait !== undefined && pendingWait !== null) {
        await this.respondHostFrameError(native.runId, pendingWait.id, "RUN_CANCELLED").catch(
          () => undefined,
        );
      }
      // 取消进行中的轮次：引擎侧等待的帧由 ACP 取消路径以错误应答唤醒。
      try {
        native.session.cancel();
      } catch (error) {
        this.logger.warn("原生会话取消失败（进程树终止兜底）", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 运行收口（停止/结算时引擎都会发 cancel_waiting）：tracker 随运行
    // 终止——状态文件落盘持久，恢复运行由引擎重新 start 幂等拉回。
    const relay = this.trackers.get(runId);
    if (relay !== undefined) {
      this.trackers.delete(runId);
      await relay.close().catch(() => undefined);
    }
  }

  /** stop_node_session：收养语义收口（session/close；连接归共享池，池化
   * transport 不 kill——与用户会话的释放路径一致）。 */
  private async stopNodeSession(sessionId: string): Promise<null> {
    const native = this.sessions.get(sessionId);
    if (native === undefined) {
      return null;
    }
    this.sessions.delete(sessionId);
    await native.close().catch(() => undefined);
    this.logger.info("工作流节点会话已由原生宿主收口", { sessionId });
    return null;
  }

  // ------------------------------------------------------------- 应答帧

  /** 宿主回调帧的应答通道（frame 与请求帧同形：JSON 字符串；runId 由引擎
   * 路由）。独立成方法便于测试注入断言。 */
  private respondHostFrame(
    runId: string,
    id: number,
    response: { result?: unknown },
  ): Promise<void> {
    return this.deps.workflow.respondHostFrame(
      runId,
      JSON.stringify({ id, response }),
    );
  }

  private respondHostFrameError(runId: string, id: number, code: string): Promise<void> {
    return this.deps.workflow
      .respondHostFrame(runId, JSON.stringify({ id, response: { code } }))
      .catch(() => undefined);
  }
}

/**
 * 引擎 RemoteHost 线帧（remote_host.rs HostFrame）解包：请求帧是
 * `{"id","request":{…}}`。返回关联 id 与请求载荷；其他形状（应答帧方向、
 * 垃圾行）返回 null 丢弃——本模块只消费引擎的请求方向。
 */
function unwrapEngineFrame(
  parsed: unknown,
): { id: number; request: HostRequestFrame } | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { id, request } = parsed as { id?: unknown; request?: unknown };
  if (
    typeof id !== "number" ||
    typeof request !== "object" ||
    request === null
  ) {
    return null;
  }
  const payload = request as { kind?: unknown };
  if (typeof payload.kind !== "string" || payload.kind.length === 0) {
    return null;
  }
  return { id, request: payload as HostRequestFrame };
}

/** 需求单的动作身份引用（与 headless 宿主的 actor 形状一致：`actor@1`）。 */
function actorRefOf(requirement: SpawnRequirementWire): string {
  return `${requirement.action.actor}@1`;
}

/** 会话身份标注用角色名（persona：__node.actor 优先，与 headless 宿主一致）。 */
function personaOf(requirement: SpawnRequirementWire): string {
  const node = (requirement.action.input as { __node?: { actor?: unknown } } | null)?.__node;
  const persona = typeof node?.actor === "string" ? node.actor : null;
  return persona ?? requirement.action.actor;
}

function actorNameOf(requirement: SpawnRequirementWire): string {
  return personaOf(requirement);
}

/** 初始需求的原文提取（与 headless 宿主 begin_action 同一规则）。 */
function initialRequirementTextOf(input: unknown): string | null {
  const vars = (input as { vars?: { input?: unknown } } | null)?.vars;
  const value = vars?.input;
  if (typeof value === "string") {
    return value;
  }
  const record = value as { requirement?: unknown } | null | undefined;
  if (record !== null && record !== undefined && typeof record.requirement === "string") {
    return record.requirement;
  }
  if (value !== null && value !== undefined) {
    return JSON.stringify(value);
  }
  return null;
}

/**
 * 收养 create 回调的握手序列（与 realRuntime 生产路径一致）：共享池开
 * 会话（project 的 openAgentsSession 出口）→ initialize → new/load →
 * profile 切换。失败时释放已开的池会话（release 回调），不留半条连接。
 */
async function openAdoptedSession(inputs: {
  readonly sessionOptions: AdoptSessionOptions;
  readonly clientInfo: { readonly name: string; readonly version: string };
  /** 需求单 mcp_servers（标准元素，原样下发）。 */
  readonly callerMcpServers: readonly McpServer[];
  /** 结果通道提供；握手后按 Agent 能力选定一种追加（resultChannel.ts）。 */
  readonly resultChannel: ResultChannelOfferWire | null;
  readonly dialect: AcpDialect | undefined;
  readonly resumeId: string | null;
  readonly cwd: string;
  /** 按角色指定的模型；只在新建会话时设置。 */
  readonly model?: string | null;
  readonly profile: string | null;
  readonly handshakeTimeoutMs: number;
  readonly agentsOpen: NativeHostDeps["openAgentsSession"];
  readonly agentId?: string;
  readonly release: (session: AcpSessionPortLike) => Promise<void>;
}): Promise<{ session: AcpSessionPortLike; close: () => Promise<void> }> {
  const { sessionOptions, release } = inputs;
  const session = await inputs.agentsOpen({
    sessionOptions,
    clientInfo: inputs.clientInfo,
    dialect: inputs.dialect,
    agentId: inputs.agentId,
  });
  try {
    const initialized = await session.initialize({ timeoutMs: inputs.handshakeTimeoutMs });
    // ADR 024 §9-3：只有握手后才知道 Agent 声明的 MCP 传输能力。
    const mcpServers =
      inputs.resultChannel === null
        ? inputs.callerMcpServers
        : [
            ...inputs.callerMcpServers,
            resultChannelServer(inputs.resultChannel, agentSupportsHttpMcp(initialized)),
          ];
    if (inputs.resumeId !== null) {
      const info = initialized as { agentCapabilities?: { loadSession?: unknown } } | null;
      if (info?.agentCapabilities?.loadSession !== true) throw new Error("WORKFLOW_AGENT_RESUME_UNSUPPORTED");
      await session.loadSession(inputs.resumeId, inputs.cwd, { mcpServers });
    } else {
      await session.newSession(inputs.cwd, { mcpServers });
      // ADR 036：按角色指定了模型。Agent 没有这个模型或不支持切换时如实失败，不悄悄用默认模型。
      if (inputs.model) {
        const available = session.models?.availableModels;
        if (available && available.length > 0 && !available.some((item) => item.modelId === inputs.model)) {
          throw new Error(`WORKFLOW_MODEL_UNAVAILABLE:${inputs.model}`);
        }
        if (!session.setModel) throw new Error(`WORKFLOW_MODEL_UNSUPPORTED:${inputs.model}`);
        try {
          await session.setModel(inputs.model);
        } catch {
          throw new Error(`WORKFLOW_MODEL_UNSUPPORTED:${inputs.model}`);
        }
      }
    }
    if (inputs.profile !== null && inputs.resumeId === null) {
      // profile 落位（原实现同款：`_session/switch_agent` 扩展请求，
      // 底座 requestExtension——ADR 024 §7 改动 2）：agent 须回执
      // toProfile 才算切换确认；缺失时如实报未确认（绝不静默跳过
      // ——引擎侧轮次推进依赖 profile 落位）。
      const response = (await session.requestExtension("_session/switch_agent", {
        agentProfile: inputs.profile,
      })) as { toProfile?: unknown } | null;
      if (typeof response?.toProfile !== "string" || response.toProfile.length === 0) {
        throw new Error("ACP_PROFILE_SWITCH_UNCONFIRMED");
      }
    }
    return {
      session,
      close: async () => {
        try {
          await session.closeSession();
        } finally {
          await release?.(session);
        }
      },
    };
  } catch (error) {
    // 启动失败不留半条连接：先释放池会话再上抛。
    try {
      await session.closeSession();
    } catch {
      /* already closed */
    }
    await release?.(session).catch(() => undefined);
    throw error;
  }
}

/** 方言工厂的输入：审批默认模式分派 + 直答面 + agent 解析（问答卡经
 * 收养会话的 approvalStore 呈现——project adoptExternalSession 的标准
 * 回调；本方只构造方言，不再自建权限应答器）。 */
export interface PermissionPolicyDeps {
  /** 问答卡直答面（挂到会话问答 UI）。 */
  readonly offerQuestions: NativeBridgeHub["offerNativeQuestions"];
  /** 方言工厂输入：当前选中 agent 的适配项（null = 未配置）。 */
  readonly resolveAgentDialect: () => {
    adapter: { createDialect?: (hooks: { onQuestion?: (sessionId: string, requestId: string, questions: readonly ChrysQuestion[], callerName: string | null) => Promise<ChrysRequestInputResult | null> }) => AcpDialect | undefined };
    activeAgentId: string;
  } | null;
}

/** 生产装配的 agent 方言挂接：按注入的 agent 解析面构造方言，私有反向
 * 请求（_chrys/request_input）经直答面挂到会话问答卡。spawn 完全按
 * 需求单执行，方言只影响通知翻译与反向请求处理。 */
export function createDialectFactory(
  policy: PermissionPolicyDeps,
  logger: Logger = createLogger("workflow-native-host"),
): () => AcpDialect | undefined {
  return () => {
    const resolved = policy.resolveAgentDialect();
    if (resolved === null) {
      logger.warn("当前 agent 无方言挂接：私有反向请求将按未知方法回绝");
      return undefined;
    }
    const dialect = resolved.adapter.createDialect?.({
      onQuestion: (sessionId, requestId, questions, callerName) =>
        policy.offerQuestions(sessionId, requestId, questions, callerName),
    });
    if (dialect === undefined) {
      logger.warn("当前 agent 无方言挂接：私有反向请求将按未知方法回绝", {
        activeAgentId: resolved.activeAgentId,
      });
    }
    return dialect;
  };
}

/** 生产装配：方言挂接走审批默认模式分派的直答面；权限/问答由收养的
 * SessionView 直答（project adoptExternalSession 回调），问题池 tracker
 * 同路 spawn（二期-3，工厂由调用方以 host.acpProcess 组装）。 */
export function productionCallbacks(
  policy: PermissionPolicyDeps,
): NativeHostCallbacks {
  return {
    createDialect: createDialectFactory(policy),
  };
}

/**
 * 装配原生会话宿主（插件 apply 调用一次）：订阅服务事件泵的宿主回调帧并
 * 应答，同时把消息队列能力注册进 nativeBridge。`enabled` 为 false（dev
 * 浏览器 / vitest——没有 acp_spawn IPC）时返回 no-op 解挂函数，如实不装
 * 配，不伪造连接。
 */
export function attachNativeSessionHost(
  deps: NativeHostDeps,
  callbacks: NativeHostCallbacks,
  enabled: boolean,
  options: { handshakeTimeoutMs?: number; logger?: Logger } = {},
): () => void {
  if (!enabled) {
    return () => {};
  }
  return NativeSessionHost.attach(deps, callbacks, options).detach;
}
