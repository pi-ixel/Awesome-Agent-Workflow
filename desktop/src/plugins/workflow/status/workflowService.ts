/**
 * 引擎线 WorkflowService 实现（ADR 024 §5 ③ / §8）。
 *
 * 职责与数据流：
 * - **引擎客户端**：持有 engine/client.ts 的 WorkflowClient，所有引擎方法
 *   （workflows / workflow / list / snapshot / start / resume / recover /
 *   stop / authorize-retry / reconcile）经 `request` 走 NDJSON 帧协议；
 * - **每 runId 快照流**：`snapshot(runId)` 返回一个 ReadonlySnapshot<
 *   CanvasSnapshot>（Map 复用）；引擎事件到达后 200ms 去抖重取（对齐旧
 *   WorkflowPanel 的刷新节奏），快照解析走 status/snapshot.ts 纯函数；
 * - **会话投影泵**：本服务是 nativeBridge 的事件投影登记处（会话内容不过
 *   引擎协议，ADR 024 §6 修正 3）——sessionHost 的 acp-session-created /
 *   acp-event 投影在此登记进 sessionMap 绑定表并经 `subscribe` 转发；
 *   会话呈现归收养的 SessionView（adoptExternalSession，§9 开放问题 1
 *   收口），不再有面板内只读会话流；
 * - **感知面**：`onSessionActivity` 只做会话标题/活动感知，更新
 *   sessionHost/sessionMap.ts 的绑定表（ADR 024 §3）。
 *
 * dispose / onSessionActivity 由插件 index.ts 解构后接线（ctx.effect 与
 * subscribeSessionActivity），`ctx.provide` 的服务对象不含它们——bootstrap
 * 对外服务面有此断言（tests/runtime/bootstrap.test.ts）。
 */
import { parsePlanEntries, type NodePlans } from "./nodePlans.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { ForegroundSessionListener } from "../../project/events.ts";
import type { NativeBridgeHub } from "../sessionHost/nativeBridge.ts";
import type { WorkflowSessionMap } from "../sessionHost/sessionMap.ts";
import type { WorkflowClient } from "../engine/client.ts";
import type { WorkflowEvent } from "../engine/protocol.ts";
import type {
  CanvasSnapshot,
  RunSessionLink,
  RunSessionLinkNode,
  RunSessionLinks,
  RunSummary,
  WorkflowLaunchRequest,
  WorkflowPreflightReport,
  WorkflowStartRequest,
  WorkflowService,
} from "../types.ts";
import { parseWorkflowDetail, parseWorkflowSummary } from "./library.ts";
import {
  deriveCanvasSnapshot,
  emptyCanvasSnapshot,
  parseInterventionOutcome,
} from "./snapshot.ts";

/** 事件到达后的去抖刷新窗口（对齐旧 WorkflowPanel 的 200ms）。 */
const REFRESH_DEBOUNCE_MS = 200;

/** WorkflowService 的装配依赖（index.ts 生产装配；测试注入桩）。 */
export interface WorkflowServiceDeps {
  readonly client: Pick<
    WorkflowClient,
    "request" | "subscribe" | "hasActiveRuns" | "hasActiveRunsFromHost"
  >;
  /** nativeBridge 单例（会话事件投影泵的登记处）。 */
  readonly bridge: NativeBridgeHub;
  /** sessionId ↔ runId/site 绑定表（感知面状态）。 */
  readonly sessions: WorkflowSessionMap;
  readonly logger: {
    debug(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** 节点 Agent 启动信封（start / resume 的 command/mcpServers）。 */
  readonly agentLaunch: (runId?: string) => {
    readonly command: readonly string[];
    readonly mcpServers: unknown;
    readonly agentId?: string;
  };
  /** 节点进度（ACP plan，ADR 035）；不给时不记录。 */
  readonly plans?: NodePlans;
}

/** 工厂返回值：服务本体 + index.ts 接线用的生命周期钩子。 */
export interface CreatedWorkflowService {
  readonly service: WorkflowService;
  readonly onSessionActivity: ForegroundSessionListener;
  readonly dispose: () => void;
}

/**
 * 每 runId 的快照流内部态。
 *
 * 生命周期跟随**订阅者**，不跟随工作区绑定：`snapshot(runId)` 交出去的流
 * 只要还有订阅者就必须持续刷新——绑定切换（导航、换项目）绝不能让一个仍被
 * 持有的流静默失效（真机 2026-11-12：侧栏点开会话 → 导航重绑 → 旧实现清空
 * runStores → 面板持有的流从此不再刷新，画布停在节点一）。运行属于创建时
 * 所在的项目，故流钉住自己的 `cwd`，不读「当前绑定」。
 */
interface RunStore {
  /** 运行所属项目（引擎 snapshot 的作用域）；创建时未绑定则首次可用时钉住。 */
  cwd: string | null;
  state: CanvasSnapshot;
  initialState: CanvasSnapshot;
  readonly listeners: Set<(state: CanvasSnapshot, previous: CanvasSnapshot) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

/** 站点身份 `` `${siteId}#${ordinal}` `` 的解析。 */
function parseSite(site: string): { siteId: string; ordinal: number } {
  const sharp = site.lastIndexOf("#");
  const siteId = sharp > 0 ? site.slice(0, sharp) : "";
  const ordinal = Number.parseInt(site.slice(sharp + 1), 10);
  if (siteId === "" || !Number.isFinite(ordinal) || ordinal < 1) {
    throw new Error("WORKFLOW_SITE_INVALID");
  }
  return { siteId, ordinal };
}

function deriveRunSummary(value: unknown): RunSummary | null {
  const parsed = deriveCanvasSnapshot({ run: value });
  return parsed.run;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** 引擎 session-links（未知来源，宽容解析）→ 每次运行的会话关联。 */
export function deriveSessionLinks(value: unknown): RunSessionLinks[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((run): RunSessionLinks[] => {
    if (typeof run !== "object" || run === null) return [];
    const item = run as Record<string, unknown>;
    const runId = text(item.runId);
    if (runId === "") return [];
    const links = Array.isArray(item.links) ? item.links : [];
    return [{
      runId,
      workflowName: text(item.workflowName),
      title: text(item.title) || text(item.workflowName),
      status: text(item.status),
      active: item.active === true,
      links: links.flatMap((link): RunSessionLink[] => {
        if (typeof link !== "object" || link === null) return [];
        const entry = link as Record<string, unknown>;
        const sessionId = text(entry.sessionId);
        if (sessionId === "") return [];
        const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
        return [{
          sessionId,
          actorName: text(entry.actorName) || text(entry.actorSiteId),
          nodes: nodes.flatMap((node): RunSessionLinkNode[] => {
            if (typeof node !== "object" || node === null) return [];
            const n = node as Record<string, unknown>;
            const siteId = text(n.siteId);
            return siteId === "" ? [] : [{
              siteId,
              ordinal: typeof n.ordinal === "number" ? n.ordinal : 0,
              status: text(n.status),
              label: text(n.label) || siteId,
              awaitingInput: n.awaitingInput === true,
            }];
          }),
        }];
      }),
    }];
  });
}

function requireCwd(cwd: string | null): string {
  if (cwd === null || cwd.trim() === "") {
    throw new Error("WORKSPACE_NOT_BOUND");
  }
  return cwd;
}

function parsePreflight(value: unknown): WorkflowPreflightReport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.items) || report.items.length === 0) return null;
  const items: WorkflowPreflightReport["items"][number][] = [];
  for (const value of report.items) {
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || typeof item.label !== "string" ||
      typeof item.message !== "string" || typeof item.hint !== "string" ||
      (item.status !== "pass" && item.status !== "warn" && item.status !== "fail")) return null;
    items.push({ id: item.id, label: item.label, status: item.status, message: item.message, hint: item.hint });
  }
  return { ...(typeof report.revision === "string" ? { revision: report.revision } : {}), ...(typeof report.configuration === "string" ? { configuration: report.configuration } : {}), items };
}

/**
 * 创建引擎线 WorkflowService（插件 apply 调用一次；测试各造各的）。
 */
export function createWorkflowService(deps: WorkflowServiceDeps): CreatedWorkflowService {
  const { client, bridge, sessions, logger } = deps;
  const listeners = new Set<(event: WorkflowEvent) => void>();
  const runStores = new Map<string, RunStore>();
  const runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let workspace: string | null = null;
  let runList: readonly RunSummary[] = [];
  let pendingFocus = "";
  let pendingLaunch: WorkflowLaunchRequest | null = null;
  let links: { workspace: string | null; runs: readonly RunSessionLinks[] } = { workspace: null, runs: [] };
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let bindingVersion = 0;

  const emit = (event: WorkflowEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* View errors must not affect execution. */
      }
    }
  };

  // ------------------------------------------------------------- list 投影

  const fetchList = async (): Promise<void> => {
    const cwd = requireCwd(workspace);
    const raw = await client.request<unknown>("list", { cwd });
    if (disposed || !Array.isArray(raw)) return;
    runList = raw.flatMap((item) => {
      const run = deriveRunSummary(item);
      return run === null ? [] : [run];
    });
    // 会话关联（侧栏分组）：失败只记日志，保留上一份，不影响运行列表。
    try {
      const rawLinks = await client.request<unknown>("session-links", { cwd });
      if (disposed) return;
      if (cwd === workspace) links = { workspace: cwd, runs: deriveSessionLinks(rawLinks) };
    } catch (error) {
      logger.warn("运行会话关联刷新失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    emit({ type: "runs-changed", runId: "" });
  };

  const refreshList = async (): Promise<void> => {
    if (disposed) return;
    try {
      await fetchList();
    } catch (error) {
      logger.warn("运行列表刷新失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scheduleList = (): void => {
    if (disposed) return;
    if (listTimer !== null) clearTimeout(listTimer);
    listTimer = setTimeout(() => {
      listTimer = null;
      void refreshList();
    }, REFRESH_DEBOUNCE_MS);
  };

  // ------------------------------------------------------------ run 快照流

  const setState = (store: RunStore, state: CanvasSnapshot): void => {
    const previous = store.state;
    if (previous === state) return;
    store.state = state;
    for (const listener of [...store.listeners]) {
      try {
        listener(state, previous);
      } catch {
        /* View errors must not affect execution. */
      }
    }
  };

  const refreshRun = async (runId: string): Promise<void> => {
    const store = runStores.get(runId);
    if (disposed || store === undefined) return;
    store.cwd ??= workspace;
    if (store.cwd === null) return;
    const cwd = store.cwd;
    const seq = ++store.seq;
    try {
      const raw = await client.request<unknown>("snapshot", { cwd, runId });
      if (disposed || store.seq !== seq || runStores.get(runId) !== store) return;
      setState(store, deriveCanvasSnapshot(raw));
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      // 引擎 journal 落盘但服务侧已清态的运行不作为面板错误（对齐旧面板）。
      if (message.includes("RUN_NOT_FOUND")) return;
      logger.warn("运行快照刷新失败", { runId, reason: message });
      emit({ type: "snapshot-error", runId, message });
    }
  };

  const scheduleRun = (runId: string): void => {
    if (disposed || runId === "") return;
    const pending = runTimers.get(runId);
    if (pending !== undefined) clearTimeout(pending);
    runTimers.set(
      runId,
      setTimeout(() => {
        runTimers.delete(runId);
        void refreshRun(runId);
      }, REFRESH_DEBOUNCE_MS),
    );
  };

  const snapshotOf = (runId: string): ReadonlySnapshot<CanvasSnapshot> => {
    let store = runStores.get(runId);
    if (store === undefined) {
      const initialState = emptyCanvasSnapshot();
      store = {
        cwd: workspace,
        state: initialState,
        initialState,
        listeners: new Set(),
        timer: null,
        seq: 0,
      };
      runStores.set(runId, store);
      void refreshRun(runId);
    }
    const bound = store;
    return {
      getState: () => bound.state,
      getInitialState: () => bound.initialState,
      subscribe: (listener) => {
        bound.listeners.add(listener);
        // 被回收过的流（订阅者曾归零）重新有了订阅者：重新登记并补一次刷新，
        // 保证「有订阅者的流一定在 runStores 里、一定随事件刷新」。
        if (!disposed && runStores.get(runId) !== bound) {
          runStores.set(runId, bound);
          void refreshRun(runId);
        }
        return () => {
          bound.listeners.delete(listener);
          // 最后一个订阅者离开才回收（不再有人看，停止随事件刷新）。
          if (bound.listeners.size === 0 && runStores.get(runId) === bound) {
            runStores.delete(runId);
          }
        };
      },
    };
  };

  // ------------------------------------------------------------ 会话投影泵

  const projector = (event: WorkflowEvent): void => {
    if (disposed) return;
    if (event.type === "acp-event") {
      const inner = event.event;
      if (inner === null || typeof inner !== "object") return;
      const payload = inner as Record<string, unknown>;
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
      // 节点会话登记（绑定表的引擎侧写入路径）。
      const instance = event.instance;
      if (payload.type === "plan" && typeof event.runId === "string" && instance !== null && typeof instance === "object") {
        const site = instance as { siteId?: unknown; ordinal?: unknown };
        const entries = parsePlanEntries(payload.entries);
        if (entries && typeof site.siteId === "string" && typeof site.ordinal === "number") {
          deps.plans?.update(event.runId, site.siteId, site.ordinal, entries);
        }
      }
      if (sessionId !== null && instance !== null && typeof instance === "object") {
        const site = instance as { siteId?: unknown; ordinal?: unknown };
        sessions.upsertNodeSession({
          sessionId,
          runId: typeof event.runId === "string" ? event.runId : "",
          siteId: typeof site.siteId === "string" ? site.siteId : null,
          ordinal: typeof site.ordinal === "number" ? site.ordinal : null,
        });
      }
    } else if (event.type === "acp-session-created" || event.type === "acp-session-restored") {
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
      if (sessionId === null) return;
      const persona = typeof event.persona === "string" ? event.persona : null;
      sessions.upsertNodeSession({
        sessionId,
        runId: typeof event.runId === "string" ? event.runId : "",
        persona,
      });
    }
    emit(event);
  };

  // ---------------------------------------------------------------- 服务面

  function startInput(request: WorkflowStartRequest, onAgentError?: (message: string) => void): Record<string, unknown> {
    const cwd = requireCwd(workspace);
    let launch: ReturnType<WorkflowServiceDeps["agentLaunch"]>;
    try { launch = deps.agentLaunch(); }
    catch (error) {
      onAgentError?.(error instanceof Error ? error.message : String(error));
      launch = { command: [], mcpServers: [] };
    }
    const title = request.title?.trim() ?? "";
    return {
      cwd, workflow: request.workflowId, entry: request.entry, inputs: request.inputs,
      ...(title ? { title } : {}),
      ...(request.autoConfirm ? { autoConfirm: true } : {}),
      command: [...launch.command],
      ...(launch.agentId ? { agentId: launch.agentId } : {}),
      mcpServers: Array.isArray(launch.mcpServers) ? launch.mcpServers : [],
    };
  }

  const service: WorkflowService = {
    isActive: () => !disposed,

    bindWorkspace(path: string | null): () => void {
      if (disposed) return () => {};
      const version = ++bindingVersion;
      const changed = workspace !== path;
      workspace = path;
      // 绑定只决定「运行列表」的作用域；快照流各自钉住所属项目，不随绑定
      // 重置（见 RunStore）。
      if (changed) {
        runList = [];
        links = { workspace: path, runs: [] };
        emit({ type: "runs-changed", runId: "" });
        void refreshList();
      }
      return () => {
        if (disposed || version !== bindingVersion) return;
        bindingVersion++;
        workspace = null;
        runList = [];
        links = { workspace: null, runs: [] };
        emit({ type: "runs-changed", runId: "" });
      };
    },

    async workflows() {
      if (disposed) throw new Error("Workflow service is disposed");
      const raw = await client.request<unknown>("workflows", {});
      return Array.isArray(raw) ? raw.flatMap((item) => parseWorkflowSummary(item) ?? []) : [];
    },

    async workflow(id: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      const detail = parseWorkflowDetail(await client.request<unknown>("workflow", { id }));
      if (detail === null) throw new Error("WORKFLOW_NOT_FOUND");
      return detail;
    },

    async copyWorkflow(id: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      const result = await client.request<{ id?: unknown }>("workflow-copy", { id });
      const copied = typeof result?.id === "string" ? result.id : "";
      if (copied === "") throw new Error("WORKFLOW_COPY_FAILED");
      emit({ type: "library-changed", runId: "" });
      return copied;
    },

    async deleteWorkflow(id: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("workflow-delete", { id });
      emit({ type: "library-changed", runId: "" });
    },

    async preflight(request) {
      if (disposed) throw new Error("Workflow service is disposed");
      let agentError = "";
      const input = startInput(request, (message) => { agentError = message; });
      const raw = await client.request<unknown>("preflight", { input });
      const report = parsePreflight(raw);
      if (report === null) throw new Error("PREFLIGHT_RESPONSE_INVALID");
      return agentError ? { ...report, items: report.items.map((item) =>
        item.id === "agent" && item.status === "fail" ? { ...item, message: agentError } : item) } : report;
    },

    async start(request, checked) {
      if (disposed) throw new Error("Workflow service is disposed");
      const result = await client.request<{ runId: unknown }>("start", {
        input: {
          ...startInput(request),
          ...(checked?.revision ? { expectedRevision: checked.revision } : {}),
          ...(checked?.configuration ? { expectedConfiguration: checked.configuration } : {}),
          ...(checked ? { acceptedWarnings: checked.acceptedWarnings } : {}),
        },
      });
      const runId = typeof result?.runId === "string" ? result.runId : "";
      if (runId === "") throw new Error("WORKFLOW_RUN_ID_MISSING");
      scheduleList();
      scheduleRun(runId);
      return { runId };
    },

    async resume(runId: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      const launch = deps.agentLaunch(runId);
      await client.request("resume", {
        cwd,
        runId,
        command: [...launch.command],
        mcpServers: Array.isArray(launch.mcpServers) ? launch.mcpServers : [],
      });
      scheduleRun(runId);
      scheduleList();
    },

    async recover(runId: string, reason: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      await client.request("recover", { cwd, runId, reason });
      scheduleRun(runId);
      scheduleList();
    },

    runs: () => runList,

    nodePlan: (runId, siteId, ordinal) => deps.plans?.get(runId, siteId, ordinal) ?? null,

    sessionLinks: () => links,

    focusRun(runId: string) {
      if (disposed || runId === "") return;
      pendingFocus = runId;
      emit({ type: "focus-run", runId });
    },

    takeFocusRun() {
      const runId = pendingFocus;
      pendingFocus = "";
      return runId;
    },

    requestLaunch(request: WorkflowLaunchRequest) {
      if (disposed) return;
      pendingLaunch = request;
      emit({ type: "focus-launch", runId: "" });
    },

    takeLaunchRequest() {
      const request = pendingLaunch;
      pendingLaunch = null;
      return request;
    },

    async refresh() {
      if (disposed) throw new Error("Workflow service is disposed");
      await fetchList();
      const runIds = [...runStores.keys()];
      await Promise.all(runIds.map((runId) => refreshRun(runId)));
    },

    snapshot: snapshotOf,

    subscribe(listener: (event: WorkflowEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async authorizeRetry(runId: string, site: string, evidence: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      const { siteId, ordinal } = parseSite(site);
      if (evidence.trim() === "") throw new Error("WORKFLOW_EVIDENCE_REQUIRED");
      await client.request("authorize-retry", { cwd, runId, siteId, ordinal, evidence: evidence.trim() });
      scheduleRun(runId);
      scheduleList();
    },

    async reconcile(runId, site, resolution) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      const { siteId, ordinal } = parseSite(site);
      if (resolution.evidence.trim() === "") throw new Error("WORKFLOW_EVIDENCE_REQUIRED");
      if (!resolution.executed) {
        // 确认未执行：引擎侧走 authorize-retry（允许重试一次）。
        await client.request("authorize-retry", {
          cwd, runId, siteId, ordinal, evidence: resolution.evidence.trim(),
        });
      } else {
        await client.request("reconcile", {
          cwd, runId, siteId, ordinal,
          evidence: resolution.evidence.trim(),
          result: resolution.result ?? null,
        });
      }
      scheduleRun(runId);
      scheduleList();
    },

    async stop(runId: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("stop", { runId });
      scheduleRun(runId);
      scheduleList();
    },

    async intervene(runId, request, options) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      const preview = options?.preview === true;
      const result = await client.request("intervene", { cwd, runId, preview, request });
      if (!preview) {
        scheduleRun(runId);
        scheduleList();
      }
      return parseInterventionOutcome(result);
    },

    async confirm(runId, instance) {
      if (disposed) throw new Error("Workflow service is disposed");
      const cwd = requireCwd(workspace);
      await client.request("confirm", { cwd, runId, instance: [...instance] });
      await service.resume(runId);
    },
  };

  // ---------------------------------------------------------------- 泵接线

  const unsubscribeClient = client.subscribe((event) => {
    if (disposed) return;
    emit(event);
    if (event.type === "service-exit") return;
    const runId = typeof event.runId === "string" ? event.runId : "";
    if (runId !== "") {
      scheduleRun(runId);
      scheduleList();
    }
  });
  bridge.registerWorkflowEventProjector(projector);

  /** 感知面：平台会话广播 → 标题/活动感知（ADR 024 §3）。 */
  const onSessionActivity: ForegroundSessionListener = (path, event) => {
    if (disposed || !("sessionId" in event)) return;
    const sessionId = event.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") return;
    sessions.noteActivity(sessionId, path, new Date().toISOString());
    if (event.type === "session_info_update") {
      sessions.noteTitle(sessionId, event.title);
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeClient();
    bridge.registerWorkflowEventProjector(null);
    if (listTimer !== null) clearTimeout(listTimer);
    for (const timer of runTimers.values()) clearTimeout(timer);
    runTimers.clear();
    runStores.clear();
    runList = [];
    listeners.clear();
  };

  return { service, onSessionActivity, dispose };
}
