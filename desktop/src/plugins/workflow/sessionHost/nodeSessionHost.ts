/**
 * 工作流节点会话的宿主（ADR 037）。
 *
 * 引擎经宿主回调帧（host-frame）要会话，这里用应用的普通会话应答。节点会话
 * 就是普通会话：由应用的会话管理打开、持有和关闭，用户任何时候都可以直接
 * 对话。工作流在会话里只做两件事：像参与者一样发这一步的任务说明，把会话的
 * 状态如实报给引擎。
 *
 * 会话是唯一来源（ADR 040）：会话每次变化（开始一轮、一轮结束）就经服务协议
 * `session-state` 报一份完整的状态——在跑哪一轮、上一轮是正常结束、被打断还是
 * 出错。引擎照着记录和推进，不再问「这一轮结束了吗」，也不猜结束的原因。
 * 序号从页面加载时的毫秒数乘 1000 起步，页面重载后仍然单调递增。
 *
 * 报告跟着会话的登记走，不跟着运行有没有在执行：会话只要挂在没结束的运行上
 * （`registered`），它的每一轮都报——运行停着时你在会话里回复了，引擎也知道。
 *
 * - spawn_node_session：打开（或恢复）会话，装上交结果工具和需求单里的工具，
 *   报一份当前状态；
 * - prompt_turn：发出任务说明，这一轮开始就应答它的轮次编号；
 * - cancel_waiting：运行停止。停下这次运行会话里进行中的一轮、不再报告；会话
 *   留着，仍是用户可以继续对话的普通会话。引擎进程退出时它在执行的运行都停了，
 *   对所有运行做同样的收尾——不然运行显示「已停止」，会话里的 Agent 还在干活；
 * - start_question_tracker / question_tracker_request：问题池 tracker 由宿主持有。
 *
 * 引擎只看到会话 id 与会话状态，看不到会话内容。
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
  /** 会话就绪：打开时排队换的工具换好了（会话正忙时排在这一轮之后）。 */
  ready(target: SessionTarget): Promise<void>;
  /** 以插件身份发一条消息；Agent 正忙等原因发不出时返回 false。 */
  send(target: SessionTarget, message: { readonly text: string; readonly display: MessageDisplay }): boolean;
  cancel(target: SessionTarget): void;
  isRunning(target: SessionTarget): boolean;
  /** 按会话 id 订阅轮次（会话还没打开也行）。 */
  watchTurns(sessionId: string, listener: (event: SessionTurnEvent) => void): () => void;
  watchEvents(target: SessionTarget, listener: (event: AcpSessionEvent) => void): () => void;
}

/** 报给引擎的会话状态（引擎 session_host.rs `SessionState` 的线格式）。 */
export interface SessionStateWire {
  readonly seq: number;
  /** 正在跑的那一轮的编号；空闲时为 null。 */
  readonly running: number | null;
  /** 最近结束的一轮；这个页面里还没见过时为 null。 */
  readonly ended: { readonly turn: number; readonly outcome: "completed" | "cancelled" | "failed"; readonly error: string | null } | null;
}

export interface NodeHostDeps {
  /** 引擎服务客户端：订阅宿主回调帧、回应答帧、报会话状态。 */
  readonly workflow: {
    subscribe(listener: (event: WorkflowEvent) => void): () => void;
    respondHostFrame(runId: string, frame: string): Promise<void>;
    reportSession(sessionId: string, state: SessionStateWire): Promise<void>;
  };
  readonly sessions: NodeSessionPort;
  /** 登记在没结束的运行上的会话（来自引擎的会话关联）：一直听、一直报。 */
  readonly registered?: {
    sessions(): ReadonlySet<string>;
    subscribe(listener: () => void): () => void;
  };
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
  /** 有一轮刚刚开始（prompt_turn 用它拿到轮次编号）。 */
  started: ((turn: number) => void) | null;
  readonly stop: () => void;
}

const FOLD_LABEL = "工作流给 Agent 的说明";

export function attachNodeSessionHost(deps: NodeHostDeps): () => void {
  const logger = deps.logger ?? createLogger("workflow-node-host");
  const sessions = new Map<string, NodeSession>();
  const trackers = new Map<string, TrackerRelay>();
  /** 各会话最近报给引擎的状态（页面内有效；重载后从「不知道上一轮」开始）。 */
  const states = new Map<string, SessionStateWire>();
  let seq = Date.now() * 1000;
  const nextSeq = () => ++seq;

  /** 报一份完整的会话状态；报丢了下一份会对齐，失败只记日志。 */
  const report = (sessionId: string, state: SessionStateWire): void => {
    states.set(sessionId, state);
    void deps.workflow.reportSession(sessionId, state).catch((error: unknown) =>
      logger.warn("会话状态报告失败", { sessionId, reason: error instanceof Error ? error.message : String(error) }),
    );
  };

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

  /** 会话开始或结束一轮：报给引擎（ADR 040）。不管这次运行在不在执行。 */
  const onTurn = (sessionId: string, event: SessionTurnEvent) => {
    const previous = states.get(sessionId);
    if (event.type === "started") {
      const turn = nextSeq();
      report(sessionId, { seq: turn, running: turn, ended: previous?.ended ?? null });
      sessions.get(sessionId)?.started?.(turn);
      return;
    }
    // 开始的事件没赶上（这一轮一开始就结束了）：结束也说明开始过，给它补一个编号。
    const turn = previous?.running ?? nextSeq();
    report(sessionId, { seq: nextSeq(), running: null, ended: { turn, outcome: event.outcome, error: event.error } });
  };

  /** 正在听的会话：登记过的，加上这个页面里接上的。 */
  const watched = new Map<string, () => void>();
  const watch = (sessionId: string) => {
    if (!watched.has(sessionId)) watched.set(sessionId, deps.sessions.watchTurns(sessionId, (event) => onTurn(sessionId, event)));
  };
  const syncWatched = () => {
    const keep = new Set([...(deps.registered?.sessions() ?? []), ...sessions.keys()]);
    for (const sessionId of keep) watch(sessionId);
    for (const [sessionId, stop] of [...watched]) {
      if (keep.has(sessionId)) continue;
      stop();
      watched.delete(sessionId);
    }
  };
  syncWatched();
  const stopRegistered = deps.registered?.subscribe(syncWatched) ?? (() => {});

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
      started: null,
      stop: () => stopEvents(),
    };
    watch(sessionId);
    const stopEvents = deps.sessions.watchEvents(fixed, (event) => emit(session, { ...event }));
    sessions.set(sessionId, session);
    // 接上会话就报一份当前状态：在跑就带上这一轮（编号此刻才有），上一轮这个页面见过才有。
    const known = states.get(sessionId);
    const running = deps.sessions.isRunning(fixed) ? known?.running ?? nextSeq() : null;
    report(sessionId, { seq: nextSeq(), running, ended: known?.ended ?? null });
    deps.onEvent?.({ type: resume ? "acp-session-restored" : "acp-session-created", runId, actor: `${requirement.action.actor}@1`, sessionId, persona });
    logger.info("工作流节点会话已打开", { sessionId, restored: resume !== undefined, site: `${requirement.action.site}#${requirement.action.ordinal}` });
    return { sessionId };
  }

  /** 发出这一步的任务说明，这一轮开始就返回它的编号。Agent 正忙（用户在聊）时等它这一轮结束再发。 */
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
      await deps.sessions.ready(session.target);
      const started = new Promise<number>((resolve) => {
        session.started = resolve;
      });
      if (deps.sessions.send(session.target, message)) {
        // 任务已进到会话：在会话里发起的那一方据此收起「正在启动工作流」（ADR 039）。
        deps.onEvent?.({ type: "session-task-sent", runId: session.runId, sessionId });
        const turn = await started;
        session.started = null;
        // 这一轮怎么结束的经会话状态报告，引擎照着记（被打断、出错都不是失败）。
        return { turn };
      }
      session.started = null;
      if (attempt >= 3) throw new Error("ACP_TURN_NOT_STARTED");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  function nextEnd(session: NodeSession): Promise<void> {
    return new Promise((resolve) => {
      const stop = deps.sessions.watchTurns(session.target.sessionId, (event) => {
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

  /** 运行停止或结算：停下这次运行会话里进行中的一轮、收掉 tracker；会话留着，登记着就照样报。 */
  async function cancelWaiting(runId: string): Promise<void> {
    for (const [sessionId, session] of [...sessions]) {
      if (session.runId !== runId) continue;
      sessions.delete(sessionId);
      session.stop();
      session.started = null;
      // 停止运行就是让 Agent 停下：会话里正在跑的一轮一起取消。
      if (deps.sessions.isRunning(session.target)) deps.sessions.cancel(session.target);
    }
    syncWatched();
    const relay = trackers.get(runId);
    if (relay) {
      trackers.delete(runId);
      await relay.close().catch(() => undefined);
    }
  }

  async function dispatch(runId: string, frame: HostRequestFrame): Promise<unknown> {
    switch (frame.kind) {
      case "spawn_node_session":
        return spawn(runId, frame.requirement as SpawnRequirementWire);
      case "prompt_turn":
        return promptTurn(String(frame.session_id), frameText(frame.prompt), frame.action);
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
      const result = await dispatch(runId, frame);
      await respond(runId, id, { result: result ?? null });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      logger.warn("宿主回调帧应答失败", { kind: frame.kind, id, reason: code });
      await respond(runId, id, { code });
    }
  }

  const unsubscribe = deps.workflow.subscribe((event) => {
    if (event.type === "service-exit") {
      const runs = new Set([...sessions.values()].map((session) => session.runId));
      for (const runId of runs) void cancelWaiting(runId);
      return;
    }
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
    stopRegistered();
    for (const stop of watched.values()) stop();
    watched.clear();
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
