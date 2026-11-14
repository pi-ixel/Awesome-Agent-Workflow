/**
 * ADR 023 二期-2（§9 第 2、3 条）→ ADR 024 §5 ②：原生宿主与链接会话
 * （linkedRuntime）之间的中介。两个方向都收拢在这里，避免
 * nativeHost ↔ linkedRuntime 循环依赖：
 *
 * - **消息入队**（linkedRuntime → 原生宿主）：用户补充消息直接进原生会话
 *   流——`queueNativeUserMessage` 交给原生宿主自己的队列（排队/送达语义
   *   宿主自担，不经过引擎 session-message 协议）；
 * - **反向请求直答**（原生宿主 → 链接会话 UI）：agent 的 permission/question
 *   由原生宿主经 `offerNativePermission` / `offerNativeQuestions` 挂到链接
 *   会话的 approvalStore，用户决定的 Promise 直接回给 AcpSession 应答——
 *   不经引擎 interactionId 路由；
 * - **原生事件投影**（原生宿主 → 链接会话视图）：原生会话的事件流
 *   （acp-session-created / acp-event 及宿主合成的会话身份标注、等待输入、
 *   用户消息呈现）经 `projectNativeEvent` 进入 linkedRuntime 的同一条投影
 *   管线，会话呈现与普通会话体系零分叉。
 *
 * 引擎只穿信封的边界不受影响：这里流转的是原生宿主与 UI 之间的会话内容，
 * 引擎进程看不到任何一项。
 *
 * 移植自 src/workflow/nativeHost/nativeBridge.ts（commit 24877d9，118 行）：
 * 源文件用模块级单例（messageQueue/broker/projector 变量）+ register*
 * 全局注册。本版本保留同一 API 面，但单例收敛为一个可构造注入的
 * NativeBridgeHub（插件装配时创建一份，测试各造各的），不再持有任何
 * 模块级可变全局。linkedRuntime 的移植（批次一后续）拿到 hub 实例即可，
 * 语义不变。
 */
import type { PermissionOption } from "../../acpRuntime/types.ts";
import type { RequestPermissionOutcome } from "../../../contracts/acp/protocol.ts";
import type { WorkflowEvent } from "../engine/protocol.ts";

/** ACP `_chrys/request_input` 的问答卡线形状（chrys AskUserQuestion）。 */
export interface ChrysQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { label: string; description: string }[];
  readonly multiSelect: boolean;
}

/** 一问的答案：选中的 label 列表 + 可选备注。 */
export interface ChrysAnswer {
  readonly values: readonly string[];
  readonly note?: string;
}

/** `_chrys/request_input` 响应（chrys ask_user.py 严格校验三键形状）。 */
export interface ChrysRequestInputResult {
  readonly answers?: readonly ChrysAnswer[];
  readonly cancelled?: boolean;
}

/** 原生宿主侧的队列能力（NativeSessionHost.attach 时注册）。 */
export interface NativeMessageQueue {
  /** 该会话是否由原生宿主管着（消息入队的路由判据）。 */
  hosted(sessionId: string): boolean;
  /** 排队一条用户消息；会话未知/入口关闭时 reject。 */
  queue(sessionId: string, text: string): Promise<void>;
}

/** 反向请求直答的 UI 面（linkedRuntime 装配时注册）。 */
export interface NativeInteractionBroker {
  offerPermission(
    sessionId: string,
    toolCall: Readonly<Record<string, unknown>>,
    options: readonly PermissionOption[],
  ): Promise<RequestPermissionOutcome>;
  offerQuestions(
    sessionId: string,
    requestId: string,
    questions: readonly ChrysQuestion[],
    callerName: string | null,
  ): Promise<ChrysRequestInputResult | null>;
}

/**
 * nativeBridge 的单例容器：原生宿主、linkedRuntime（或其插件替代者）
 * 各持同一份，按方向注册与消费。三个槽位全部可选——未注册时按各自
 * 的安全默认（消息拒绝、交互取消、事件丢弃）。
 */
export class NativeBridgeHub {
  private messageQueue: NativeMessageQueue | null = null;
  private broker: NativeInteractionBroker | null = null;
  private projector: ((event: WorkflowEvent) => void) | null = null;

  /** 原生宿主装配/解挂时注册队列能力（内部）。 */
  registerNativeMessageQueue(queue: NativeMessageQueue | null): void {
    this.messageQueue = queue;
  }

  /** linkedRuntime 装配/解挂时注册直答 UI 与事件投影（内部）。 */
  registerNativeInteractionBroker(
    registered: NativeInteractionBroker | null,
  ): void {
    this.broker = registered;
  }

  registerWorkflowEventProjector(
    sink: ((event: WorkflowEvent) => void) | null,
  ): void {
    this.projector = sink;
  }

  /** 该会话是否由原生宿主管着（linkedRuntime 消息路由的判据）。 */
  isNativelyHosted(sessionId: string): boolean {
    return this.messageQueue?.hosted(sessionId) ?? false;
  }

  /** 用户补充消息进原生会话流；宿主未装配或会话未托管时 reject。 */
  queueNativeUserMessage(sessionId: string, text: string): Promise<void> {
    if (this.messageQueue === null) {
      return Promise.reject(new Error("NATIVE_HOST_NOT_ATTACHED"));
    }
    return this.messageQueue.queue(sessionId, text);
  }

  /** 原生宿主挂权限卡；无直答 UI（会话未投影等）按安全默认取消。 */
  offerNativePermission(
    sessionId: string,
    toolCall: Readonly<Record<string, unknown>>,
    options: readonly PermissionOption[],
  ): Promise<RequestPermissionOutcome> {
    if (this.broker === null) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    return this.broker.offerPermission(sessionId, toolCall, options).catch(() => ({
      outcome: "cancelled" as const,
    }));
  }

  /** 原生宿主挂问答卡；无直答 UI（会话未投影等）按安全默认取消。 */
  offerNativeQuestions(
    sessionId: string,
    requestId: string,
    questions: readonly ChrysQuestion[],
    callerName: string | null,
  ): Promise<ChrysRequestInputResult | null> {
    if (this.broker === null) {
      return Promise.resolve({ cancelled: true });
    }
    return this.broker.offerQuestions(sessionId, requestId, questions, callerName).catch(() => ({
      cancelled: true,
    }));
  }

  /** 原生宿主发布一条投影事件（acp-session-created / acp-event 形状）。 */
  projectNativeEvent(event: WorkflowEvent): void {
    this.projector?.(event);
  }
}
