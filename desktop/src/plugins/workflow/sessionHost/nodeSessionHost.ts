/**
 * 工作流节点会话的宿主（ADR 037）。
 *
 * 引擎经宿主回调帧（host-frame）要会话，这里用应用的普通会话应答。节点会话
 * 就是普通会话：由应用的会话管理打开、持有和关闭，用户任何时候都可以直接
 * 对话。工作流在会话里只做两件事：像参与者一样发这一步的任务说明，订阅
 * 轮次事件判断进展。
 *
 * - spawn_node_session：打开（或恢复）会话，装上交结果工具和需求单里的工具；
 * - prompt_turn：发出任务说明，等这一轮结束。被用户打断不算失败，交没交
 *   结果由引擎看；
 * - wait_turn_ended：等这个会话的下一轮结束，不管是谁发起的；
 * - cancel_waiting：运行停止。停下进行中的一轮、唤醒挂起的等待；会话留着，
 *   仍是用户可以继续对话的普通会话；
 * - start_question_tracker / question_tracker_request：问题池 tracker 由宿主持有。
 *
 * 引擎只看到会话 id 与轮次边界，看不到会话内容。
 */
import { pluginMessage, type MessageDisplay } from "../../../shared/messageDisplay.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { PluginSessionOptions, SessionTarget, SessionTurnEvent } from "../../project/service.ts";
import type {
  HostRequestFrame,
  SpawnRequirementWire,
  TrackerStartParamsWire,
  WorkflowActionWire,
  WorkflowEvent,
} from "../engine/protocol.ts";
import {
  agentSupportsHttpMcp,
  asResultChannelOffer,
  resultChannelServer,
  standardMcpServers,
} from "./resultChannel.ts";
import { TrackerRelay, type TrackerTransport } from "./trackerRelay.ts";

/** 宿主用到的会话能力（生产由 project.sessions / project.conversation 提供）。 */
export interface NodeSessionPort {
  open(options: PluginSessionOptions): Promise<SessionTarget>;
  /** 以插件身份发一条消息；Agent 正忙等原因发不出时返回 false。 */
  send(target: SessionTarget, message: { readonly text: string; readonly display: MessageDisplay }): boolean;
  cancel(target: SessionTarget): void;
  isRunning(target: SessionTarget): boolean;
  watchTurns(target: SessionTarget, listener: (event: SessionTurnEvent) => void): () => void;
  watchEvents(target: SessionTarget, listener: (event: AcpSessionEvent) => void): () => void;
}

export interface NodeHostDeps {
  /** 引擎服务客户端：订阅宿主回调帧、回应答帧。 */
  readonly workflow: {
    subscribe(listener: (event: WorkflowEvent) => void): () => void;
    respondHostFrame(runId: string, frame: string): Promise<void>;
  };
  readonly sessions: NodeSessionPort;
  /** 拉起问题池 tracker 进程。 */
  readonly openTrackerTransport?: (params: TrackerStartParamsWire) => Promise<TrackerTransport>;
  /** 节点会话的事件（运行视图显示 Agent 最新输出、计划更新用）。 */
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly logger?: Logger;
}

/** 这次运行里宿主持有的一个节点会话。 */
interface NodeSession {
  readonly runId: string;
  readonly target: SessionTarget & { readonly sessionId: string };
  readonly persona: string;
  /** 当前这一步（事件归到哪个节点）。 */
  action: WorkflowActionWire;
  /** 结束过几轮。 */
  ended: number;
  /** 已经告诉过引擎的那几轮。 */
  acknowledged: number;
  /** 引擎挂起的「等下一轮结束」帧。 */
  pendingWait: number | null;
  /** prompt_turn 正在等的那一轮的结束。 */
  turnEnd: ((event: Extract<SessionTurnEvent, { type: "ended" }>) => void) | null;
  /** 有一轮刚刚开始（prompt_turn 用它确认消息发出去了）。 */
  started: (() => void) | null;
  readonly stop: () => void;
}

const FOLD_LABEL = "工作流给 Agent 的说明";

export function attachNodeSessionHost(deps: NodeHostDeps): () => void {
  const logger = deps.logger ?? createLogger("workflow-node-host");
  const sessions = new Map<string, NodeSession>();
  const trackers = new Map<string, TrackerRelay>();

  const respond = (runId: string, id: number, response: { result: unknown } | { code: string }) =>
    deps.workflow.respondHostFrame(runId, JSON.stringify({ id, response })).catch((error: unknown) =>
      logger.warn("宿主应答帧发送失败", { reason: error instanceof Error ? error.message : String(error) }),
    );

  const emit = (session: NodeSession, event: Record<string, unknown>) =>
    deps.onEvent?.({
      type: "acp-event",
      runId: session.runId,
      actor: `${session.action.actor}@1`,
      instance: { siteId: session.action.site, ordinal: session.action.ordinal },
      event: { ...event, sessionId: session.target.sessionId },
    });

  /** 一轮结束：先满足正在等的 prompt_turn，再满足挂起的 wait。 */
  const onTurn = (session: NodeSession, event: SessionTurnEvent) => {
    if (event.type === "started") {
      session.started?.();
      return;
    }
    session.ended += 1;
    const turnEnd = session.turnEnd;
    if (turnEnd) {
      session.turnEnd = null;
      session.acknowledged = session.ended;
      turnEnd(event);
      return;
    }
    if (session.pendingWait !== null) {
      const id = session.pendingWait;
      session.pendingWait = null;
      session.acknowledged = session.ended;
      void respond(session.runId, id, { result: null });
    }
  };

  async function ensureTracker(runId: string, params: TrackerStartParamsWire | null | undefined): Promise<void> {
    if (trackers.has(runId)) return;
    if (!params || typeof params.session !== "string" || params.session === "") throw new Error("QUESTION_POOL_SPAWN_FAILED");
    if (!deps.openTrackerTransport) throw new Error("QUESTION_TRACKER_TRANSPORT_UNAVAILABLE");
    const transport = await deps.openTrackerTransport(params);
    const relay = new TrackerRelay(transport);
    try {
      await relay.handshake(params.session);
    } catch (error) {
      await transport.kill().catch(() => undefined);
      throw error;
    }
    trackers.set(runId, relay);
  }

  async function spawn(runId: string, requirement: SpawnRequirementWire): Promise<unknown> {
    if (!requirement || typeof requirement.cwd !== "string" || requirement.cwd === "") throw new Error("ACP_PROCESS_CONFIGURATION_INVALID");
    if (requirement.question_tracker) await ensureTracker(runId, requirement.question_tracker);
    const offer = requirement.result_channel == null ? null : asResultChannelOffer(requirement.result_channel);
    if (requirement.result_channel != null && offer === null) throw new Error("RESULT_CHANNEL_OFFER_INVALID");
    const callerTools = standardMcpServers(requirement.mcp_servers);
    const persona = personaOf(requirement.action);
    const tools = (agent: Parameters<NonNullable<Parameters<NodeSessionPort["open"]>[0]["tools"]>>[0]) =>
      [...callerTools, ...(offer ? [resultChannelServer(offer, agentSupportsHttpMcp(agent))] : [])];
    const open = (resumeSessionId: string | undefined) => deps.sessions.open({
      workspacePath: requirement.cwd,
      title: persona,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(requirement.model ? { model: requirement.model } : {}),
      tools,
    });
    let resume = requirement.resume_session_id ?? undefined;
    let target: Awaited<ReturnType<typeof open>>;
    try {
      target = await open(resume);
    } catch (error) {
      // 发起运行的会话接不上（ADR 039 兜底，例如 Agent 不接受同一连接上重新载入）：
      // 第一步改开新会话执行，当前会话不受影响。宿主换代后的续跑不走这里。
      if (!requirement.entry_session || !resume) throw error;
      logger.warn("发起运行的会话接不上，第一步改开新会话", {
        sessionId: resume,
        reason: error instanceof Error ? error.message : String(error),
      });
      resume = undefined;
      target = await open(undefined);
    }
    const sessionId = target.sessionId;
    if (!sessionId) throw new Error("ACP_SESSION_ID_MISSING");
    sessions.get(sessionId)?.stop();
    const fixed = { ...target, sessionId };
    const session: NodeSession = {
      runId,
      target: fixed,
      persona,
      action: requirement.action,
      ended: 0,
      acknowledged: 0,
      pendingWait: null,
      turnEnd: null,
      started: null,
      stop: () => {
        stopTurns();
        stopEvents();
      },
    };
    const stopTurns = deps.sessions.watchTurns(fixed, (event) => onTurn(session, event));
    const stopEvents = deps.sessions.watchEvents(fixed, (event) => emit(session, { ...event }));
    sessions.set(sessionId, session);
    deps.onEvent?.({ type: resume ? "acp-session-restored" : "acp-session-created", runId, actor: `${requirement.action.actor}@1`, sessionId, persona });
    logger.info("工作流节点会话已打开", { sessionId, restored: resume !== undefined, site: `${requirement.action.site}#${requirement.action.ordinal}` });
    return { sessionId };
  }

  /** 发出这一步的任务说明并等这一轮结束。Agent 正忙（用户在聊）时等它这一轮结束再发。 */
  async function promptTurn(sessionId: string, prompt: string, action: unknown): Promise<unknown> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("WORKFLOW_SESSION_NOT_HOSTED");
    if (!isAction(action)) throw new Error("WORKFLOW_ACTION_INVALID");
    session.action = action;
    emit(session, { type: "workflow_context", actor: session.persona, text: prompt });
    const requirement = initialRequirementOf(action.input);
    const message = pluginMessage({ source: "workflow", foldLabel: FOLD_LABEL, folded: prompt, ...(requirement ? { visible: requirement } : {}) });
    for (let attempt = 0; ; attempt++) {
      if (deps.sessions.isRunning(session.target)) await nextEnd(session);
      const ended = new Promise<Extract<SessionTurnEvent, { type: "ended" }>>((resolve) => {
        session.turnEnd = resolve;
      });
      const started = new Promise<void>((resolve) => {
        session.started = resolve;
      });
      if (deps.sessions.send(session.target, message)) {
        // 任务已进到会话：在会话里发起的那一方据此收起「正在启动工作流」（ADR 039）。
        deps.onEvent?.({ type: "session-task-sent", runId: session.runId, sessionId });
        await started;
        session.started = null;
        const outcome = await ended;
        // 被打断（用户在会话里点了停止）不算失败：结果交没交由引擎看，没交就是「等你回复」。
        if (outcome.outcome === "failed") throw new Error(outcome.error ?? "ACP_TURN_FAILED");
        return null;
      }
      session.turnEnd = null;
      session.started = null;
      if (attempt >= 3) throw new Error("ACP_TURN_NOT_STARTED");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  function nextEnd(session: NodeSession): Promise<void> {
    return new Promise((resolve) => {
      const stop = deps.sessions.watchTurns(session.target, (event) => {
        if (event.type !== "ended") return;
        stop();
        resolve();
      });
      if (!deps.sessions.isRunning(session.target)) {
        stop();
        resolve();
      }
    });
  }

  /** 等这个会话的下一轮结束（不管谁发起的）。这之前已经结束、还没告诉引擎的一轮立即算数。 */
  function waitTurnEnded(sessionId: string, id: number): "deferred" {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("WORKFLOW_SESSION_NOT_HOSTED");
    if (session.pendingWait !== null) throw new Error("WORKFLOW_WAIT_ALREADY_PENDING");
    if (session.ended > session.acknowledged && !deps.sessions.isRunning(session.target)) {
      session.acknowledged = session.ended;
      void respond(session.runId, id, { result: null });
      return "deferred";
    }
    session.pendingWait = id;
    return "deferred";
  }

  /** 运行停止或结算：停下进行中的一轮、唤醒挂起的等待、收掉 tracker；会话留着。 */
  async function cancelWaiting(runId: string): Promise<void> {
    for (const [sessionId, session] of [...sessions]) {
      if (session.runId !== runId) continue;
      sessions.delete(sessionId);
      session.stop();
      if (session.pendingWait !== null) await respond(runId, session.pendingWait, { code: "RUN_CANCELLED" });
      if (session.turnEnd) deps.sessions.cancel(session.target);
      session.turnEnd?.({ type: "ended", outcome: "cancelled", stopReason: "cancelled", error: null });
      session.turnEnd = null;
    }
    const relay = trackers.get(runId);
    if (relay) {
      trackers.delete(runId);
      await relay.close().catch(() => undefined);
    }
  }

  async function dispatch(runId: string, id: number, frame: HostRequestFrame): Promise<unknown> {
    switch (frame.kind) {
      case "spawn_node_session":
        return spawn(runId, frame.requirement as SpawnRequirementWire);
      case "prompt_turn":
        return promptTurn(String(frame.session_id), frameText(frame.prompt), frame.action);
      case "wait_turn_ended":
        return waitTurnEnded(String(frame.session_id), id);
      case "start_question_tracker":
        await ensureTracker(runId, frame.params as TrackerStartParamsWire);
        return null;
      case "question_tracker_request": {
        const relay = trackers.get(runId);
        if (!relay) throw new Error("QUESTION_TRACKER_NOT_STARTED");
        return relay.request(frameText(frame.method), frame.params ?? null);
      }
      default:
        throw new Error(`UNKNOWN_HOST_REQUEST:${frame.kind}`);
    }
  }

  async function handleFrame(runId: string, id: number, frame: HostRequestFrame): Promise<void> {
    // cancel_waiting 只发不等应答：回应答帧会在引擎那边变成无主帧。
    if (frame.kind === "cancel_waiting") {
      await cancelWaiting(runId);
      return;
    }
    try {
      const result = await dispatch(runId, id, frame);
      if (result === "deferred") return;
      await respond(runId, id, { result: result ?? null });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      logger.warn("宿主回调帧应答失败", { kind: frame.kind, id, reason: code });
      await respond(runId, id, { code });
    }
  }

  const unsubscribe = deps.workflow.subscribe((event) => {
    if (event.type !== "host-frame") return;
    const runId = typeof event.runId === "string" ? event.runId : null;
    let frame: { id: number; request: HostRequestFrame } | null;
    try {
      frame = unwrapEngineFrame(typeof event.frame === "string" ? JSON.parse(event.frame) : event.frame);
    } catch {
      frame = null;
    }
    if (runId === null || frame === null) {
      logger.warn("宿主回调帧信封不完整，丢弃", { hasRunId: runId !== null });
      return;
    }
    void handleFrame(runId, frame.id, frame.request);
  });

  return () => {
    unsubscribe();
    for (const session of sessions.values()) session.stop();
    sessions.clear();
    for (const relay of trackers.values()) void relay.close().catch(() => undefined);
    trackers.clear();
  };
}

/** 宿主回调帧里的文本字段：不是字符串时当作空串。 */
const frameText = (value: unknown): string => (typeof value === "string" ? value : "");

function isAction(value: unknown): value is WorkflowActionWire {
  const action = value as Partial<WorkflowActionWire> | null;
  return typeof action === "object" && action !== null && typeof action.site === "string" &&
    typeof action.ordinal === "number" && typeof action.actor === "string";
}

function unwrapEngineFrame(parsed: unknown): { id: number; request: HostRequestFrame } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const { id, request } = parsed as { id?: unknown; request?: unknown };
  if (typeof id !== "number" || typeof request !== "object" || request === null) return null;
  const kind = (request as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "" ? { id, request: request as HostRequestFrame } : null;
}

/** 会话的角色名（侧栏标题）：节点定义里的角色优先。 */
function personaOf(action: WorkflowActionWire): string {
  const node = (action.input as { __node?: { actor?: unknown } } | null)?.__node;
  return typeof node?.actor === "string" ? node.actor : action.actor;
}

/** 运行第一步带着用户最初的要求：会话里照常显示成用户的话。 */
function initialRequirementOf(input: unknown): string | null {
  const record = input as { __initial?: unknown; vars?: { input?: unknown } } | null;
  if (record?.__initial !== true) return null;
  const value = record.vars?.input;
  if (typeof value === "string") return value;
  const requirement = (value as { requirement?: unknown } | null | undefined)?.requirement;
  if (typeof requirement === "string") return requirement;
  if (value === null || value === undefined) return null;
  // 没填输入（空对象 / 空数组）时用户什么也没说，不显示「{}」。
  if (typeof value === "object" && Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}
