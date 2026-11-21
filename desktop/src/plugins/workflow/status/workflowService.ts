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
 * - **节点会话事件**：节点会话宿主把会话事件（Agent 的输出、计划更新）
 *   交给 `project`，在此更新节点计划并经 `subscribe` 转发给运行视图。会话
 *   本身是应用的普通会话（ADR 037），这里只是运行视图的旁听。
 *
 * dispose / project 由插件 index.ts 解构后接线，`ctx.provide` 的服务对象
 * 不含它们——bootstrap 对外服务面有此断言（tests/runtime/bootstrap.test.ts）。
 */
import { pathKey } from "../../../shared/panelPaths.ts";
import { parsePlanEntries, type NodePlans } from "./nodePlans.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { WorkflowClient } from "../engine/client.ts";
import type { WorkflowEvent } from "../engine/protocol.ts";
import type {
  CanvasSnapshot,
  RunSessionLink,
  RunSessionLinkNode,
  RunSessionLinks,
  RunSummary,
  WorkflowPanelRequest,
  WorkflowPreflightReport,
  WorkflowStartRequest,
  WorkflowService,
} from "../types.ts";
import { parseDraft, parseDraftCheck, parseImportPreview, parseWorkflowDetail, parseWorkflowSummary } from "./library.ts";
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
  readonly logger: {
    debug(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** 节点 Agent 启动信封（start / resume 的 command/mcpServers）。 */
  readonly agentLaunch: (runId?: string, workflowId?: string) => {
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
  /** 节点会话宿主交来的事件（会话创建、Agent 输出、计划更新）。 */
  readonly project: (event: WorkflowEvent) => void;
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
      ...(item.archived === true ? { archived: true } : {}),
      ...(item.failed === true ? { failed: true } : {}),
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
  const { client, logger } = deps;
  const listeners = new Set<(event: WorkflowEvent) => void>();
  const runStores = new Map<string, RunStore>();
  const runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let workspace: string | null = null;
  let runList: readonly RunSummary[] = [];
  let pendingFocus = "";
  let pendingPanelRequest: WorkflowPanelRequest | null = null;
  let links: { workspace: string | null; runs: readonly RunSessionLinks[] } = { workspace: null, runs: [] };
  let otherLinks: readonly { project: string; runs: readonly RunSessionLinks[] }[] = [];
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

  // 其他项目的会话关联（侧栏给每个项目分组）：没打开项目时也要拉，否则侧栏里的节点会话会平铺。
  // 失败只记日志、保留上一份。
  const fetchOtherLinks = async (cwd: string | null): Promise<void> => {
    const version = bindingVersion;
    try {
      const raw = await client.request<unknown>("session-links-others", { exclude: cwd ?? "" });
      if (disposed || version !== bindingVersion) return;
      if (Array.isArray(raw) && cwd === workspace) {
        otherLinks = raw.flatMap((item: unknown) => {
          if (typeof item !== "object" || item === null) return [];
          const { project, runs } = item as { project?: unknown; runs?: unknown };
          return typeof project === "string" && project ? [{ project, runs: deriveSessionLinks(runs) }] : [];
        });
      }
    } catch (error) {
      logger.warn("其他项目的会话关联刷新失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const fetchList = async (): Promise<void> => {
    const version = bindingVersion;
    if (workspace === null) {
      await fetchOtherLinks(null);
      if (!disposed && version === bindingVersion) emit({ type: "runs-changed", runId: "" });
      return;
    }
    const cwd = requireCwd(workspace);
    const raw = await client.request<unknown>("list", { cwd });
    if (disposed || version !== bindingVersion || !Array.isArray(raw)) return;
    runList = raw.flatMap((item) => {
      const run = deriveRunSummary(item);
      return run === null ? [] : [run];
    });
    // 会话关联（侧栏分组）：失败只记日志，保留上一份，不影响运行列表。
    try {
      const rawLinks = await client.request<unknown>("session-links", { cwd });
      if (disposed || version !== bindingVersion) return;
      // 已归档的运行带 archived 标记：侧栏据此把它的会话一起隐去（ADR 036）。
      if (cwd === workspace) links = { workspace: cwd, runs: deriveSessionLinks(rawLinks) };
    } catch (error) {
      logger.warn("运行会话关联刷新失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (version !== bindingVersion) return;
    await fetchOtherLinks(cwd);
    if (!disposed && version === bindingVersion) emit({ type: "runs-changed", runId: "" });
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
      const payload = event.event as Record<string, unknown> | null;
      const site = event.instance as { siteId?: unknown; ordinal?: unknown } | null;
      if (payload?.type === "plan" && typeof event.runId === "string" && site && typeof site.siteId === "string" && typeof site.ordinal === "number") {
        const entries = parsePlanEntries(payload.entries);
        if (entries) deps.plans?.update(event.runId, site.siteId, site.ordinal, entries);
      }
    }
    emit(event);
  };

  // ---------------------------------------------------------------- 服务面

  function startInput(request: WorkflowStartRequest, onAgentError?: (message: string) => void): Record<string, unknown> {
    const cwd = requireCwd(workspace);
    let launch: ReturnType<WorkflowServiceDeps["agentLaunch"]>;
    try { launch = deps.agentLaunch(undefined, request.workflowId); }
    catch (error) {
      onAgentError?.(error instanceof Error ? error.message : String(error));
      launch = { command: [], mcpServers: [] };
    }
    const title = request.title?.trim() ?? "";
    return {
      cwd, workflow: request.workflowId, entry: request.entry, inputs: request.inputs,
      ...(title ? { title } : {}),
      ...(request.autoConfirm ? { autoConfirm: true } : {}),
      ...(request.entrySession ? { entrySession: request.entrySession } : {}),
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
        pendingFocus = "";
        pendingPanelRequest = null;
        runList = [];
        links = { workspace: path, runs: [] };
        emit({ type: "runs-changed", runId: "" });
        void refreshList();
      } else if (path === null) {
        // 没打开项目：仍要拉各项目的会话关联，侧栏才能分组。
        void refreshList();
      }
      return () => {
        if (disposed || version !== bindingVersion) return;
        bindingVersion++;
        workspace = null;
        runList = [];
        links = { workspace: null, runs: [] };
        emit({ type: "runs-changed", runId: "" });
        scheduleList();
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

    async exportWorkflow(id: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      return `${JSON.stringify(await client.request<unknown>("workflow-export", { id }), null, 2)}\n`;
    },

    async importWorkflow(text, options) {
      if (disposed) throw new Error("Workflow service is disposed");
      let pkg: unknown;
      try { pkg = JSON.parse(text); } catch { throw new Error("WORKFLOW_PACKAGE_INVALID"); }
      const preview = parseImportPreview(await client.request<unknown>("workflow-import", { package: pkg, preview: options?.preview === true }));
      if (preview === null) throw new Error("WORKFLOW_PACKAGE_INVALID");
      if (options?.preview !== true) emit({ type: "library-changed", runId: "" });
      return preview;
    },

    async drafts() {
      if (disposed) throw new Error("Workflow service is disposed");
      const raw = await client.request<unknown>("drafts", {});
      return (Array.isArray(raw) ? raw : []).flatMap((item) => parseDraft(item) ?? []);
    },

    async createDraft(options) {
      if (disposed) throw new Error("Workflow service is disposed");
      const draft = parseDraft(await client.request<unknown>("draft-create", { ...options }));
      if (draft === null) throw new Error("DRAFT_CREATE_FAILED");
      return draft;
    },

    async checkDraft(draftId) {
      if (disposed) throw new Error("Workflow service is disposed");
      const check = parseDraftCheck(await client.request<unknown>("draft-check", { draftId }));
      if (check === null) throw new Error("DRAFT_NOT_FOUND");
      return check;
    },

    async saveDraft(draftId) {
      if (disposed) throw new Error("Workflow service is disposed");
      const result = await client.request<{ id?: unknown }>("draft-save", { draftId });
      const id = typeof result?.id === "string" ? result.id : "";
      if (id === "") throw new Error("DRAFT_SAVE_FAILED");
      emit({ type: "library-changed", runId: "" });
      return id;
    },

    async discardDraft(draftId) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("draft-discard", { draftId });
    },

    async trustScripts(id: string) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("workflow-trust", { id });
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

    runs: () => runList.filter((run) => run.archivedAt == null),

    allRuns: () => runList,

    async runsAcrossProjects() {
      if (disposed) throw new Error("Workflow service is disposed");
      const raw = await client.request<unknown>("list-all", {});
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((item) => {
        const run = deriveRunSummary(item);
        const project = typeof item === "object" && item !== null ? text((item as { project?: unknown }).project) : "";
        return run === null || !project ? [] : [{ ...run, project }];
      });
    },

    async renameRun(runId, title, project) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("run-rename", { cwd: project ?? requireCwd(workspace), runId, title });
      await fetchList();
      scheduleRun(runId);
    },

    async archiveRun(runId, archived, project) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("run-archive", { cwd: project ?? requireCwd(workspace), runId, archived });
      await fetchList();
    },

    async deleteRun(runId, project) {
      if (disposed) throw new Error("Workflow service is disposed");
      await client.request("run-delete", { cwd: project ?? requireCwd(workspace), runId });
      await fetchList();
    },

    nodePlan: (runId, siteId, ordinal) => deps.plans?.get(runId, siteId, ordinal) ?? null,

    sessionLinks: () => links,

    otherSessionLinks: () => otherLinks,

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

    requestPanel(request: WorkflowPanelRequest) {
      if (disposed) return;
      pendingPanelRequest = request;
      emit({ type: "focus-workflow-panel", runId: "" });
    },

    takePanelRequest(project) {
      const request = pendingPanelRequest;
      if (request?.kind === "run" && pathKey(project ?? "") !== pathKey(request.project)) return null;
      pendingPanelRequest = null;
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
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeClient();
    if (listTimer !== null) clearTimeout(listTimer);
    for (const timer of runTimers.values()) clearTimeout(timer);
    runTimers.clear();
    runStores.clear();
    runList = [];
    listeners.clear();
  };

  return { service, project: projector, dispose };
}
