/**
 * 工作流引擎（workflow_service.exe）的 wire 协议类型（ADR 024 §5 ①）。
 *
 * 移植自 src/core/workflowService.ts（commit 24877d9）内联定义的信封/句柄
 * 类型，并把原本散在 nativeSessionHost.ts / trackerRelay.ts 的宿主帧载荷
 * 类型集中到这里（engine 与 sessionHost 两处共用，ADR 024 §5 产出 2）。
 * 线格式与 Rust 侧一一对应：
 *
 * - 引擎→Desktop：NDJSON 事件信封行（bin/workflow_service.rs 的 EventSink
 *   `{"type":"event","event":…}`），经 Tauri 命令 `workflow_service` 中继为
 *   `aaw://workflow-service` 事件（Envelope 载荷，Rust 层附 generation）；
 * - Desktop→引擎：`workflow_service_write`（{id, method, params}）与
 *   `workflow_service_host_frame_response`（宿主应答帧，JSON 字符串，
 *   remote_host.rs `HostFrame` `{"id","request":…}` / `{"id","response":…}`）。
 *
 * 类型只做收窄与文档；所有外部数据仍按 unknown 处理（引擎线上的宽容解析
 * 落在各消费方）。
 */

/** 引擎推送的运行事件（事件信封 event 字段的形状；type 判别 + 透传字段）。 */
export interface WorkflowEvent {
  type: string;
  runId: string;
  [key: string]: unknown;
}

/** `aaw://workflow-service` 事件的载荷（workflow_service.rs 附 generation）。 */
export interface WorkflowEnvelope {
  generation: number;
  message: {
    type: string;
    id?: number;
    error?: string;
    result?: unknown;
    event?: WorkflowEvent;
  };
}

/** `workflow_service_start` 的返回（Rust ServiceHandle）。 */
export interface WorkflowServiceHandle {
  generation: number;
  pid: number;
}

/** `aaw://workflow-service-exit` 事件的载荷。 */
export interface WorkflowServiceExit {
  generation: number;
  code: number | null;
}

/**
 * 宿主回调帧（与引擎 remote_host.rs 的 serde 线格式一一对应）：请求帧是
 * `{"id","request":{kind,…}}`，应答帧同形 `{"id","response":{result|code}}`。
 * kind 的全集见 remote_host.rs `HostRequest`（serde tag="kind" snake_case）：
 * spawn_node_session / prompt_turn / wait_turn_ended / stop_node_session /
 * enqueue_user_message / cancel_waiting / start_question_tracker /
 * question_tracker_request。
 *
 * ⚠ 活引信：`enqueue_user_message` 是用户消息原文过引擎线的唯一帧型，
 * 当前装配**没有任何生产触发方**（面板会话流只读，交互卡待批次二收敛；
 * 原生补充消息走 nativeBridge 的原生队列，不经引擎）。在批次二明确接线
 * 或注销之前，任何新代码都不得触发该帧——引擎只穿信封的边界依赖它保持
 * 不用（ADR 023 §2.2 只许可调度文本 prompt_turn 过线）。
 */
export interface HostRequestFrame {
  readonly id: number;
  readonly kind: string;
  readonly [key: string]: unknown;
}

/** 需求单的动作身份（Rust Action；serde 直传，字段保持 wire 命名）。 */
export interface WorkflowActionWire {
  readonly site: string;
  readonly ordinal: number;
  readonly actor: string;
  readonly input: unknown;
}

/** 问题池 tracker 启动参数的 serde 线形状（session_host.rs TrackerStartParams）。 */
export interface TrackerStartParamsWire {
  readonly executable: string;
  readonly cwd: string;
  readonly home: string | null;
  readonly session: string;
}

/** 结果通道的可达方式（result_channel.rs ResultChannelOffer 的 serde 形状）。 */
export interface ResultChannelOfferWire {
  readonly name: string;
  readonly stdio: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: readonly { readonly name: string; readonly value: string }[];
  };
  readonly http: {
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
  };
}

/**
 * 引擎→Desktop 的 spawn 请求载荷（session_host.rs SessionRequirement 的
 * serde 形状；字段是信封——动作身份 + 配置，不含会话内容）。
 */
export interface SpawnRequirementWire {
  readonly action: WorkflowActionWire;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly profile: string | null;
  /** 调用方配置的 MCP 清单（标准 ACP 元素，serde_json::Value 原样过线；
   * 不含结果通道）。sessionHost 经 standardMcpServers 收窄后下发。 */
  readonly mcp_servers: unknown;
  /** 结果通道的全部可达方式（ADR 024 §9-3）；宿主握手后按
   * resultChannel.ts 的唯一规则选定一种追加到 MCP 清单。 */
  readonly result_channel?: ResultChannelOfferWire | null;
  readonly resume_session_id: string | null;
  /** 问题池 tracker 启动参数（二期-3；仅 agent 节点的运行携带）。 */
  readonly question_tracker?: TrackerStartParamsWire | null;
}

/** 挂起的宿主回调帧等待（wait_turn_ended 的 deferred 应答标记）。 */
export interface PendingHostWait {
  readonly id: number;
  readonly sessionId: string;
}
