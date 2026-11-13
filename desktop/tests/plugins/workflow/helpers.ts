import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import type {
  CanvasSnapshot,
  RunSummary,
  WorkflowDetail,
  WorkflowLaunchRequest,
  WorkflowService,
  WorkflowSummary,
} from "../../../src/plugins/workflow/types.ts";
import { emptyCanvasSnapshot } from "../../../src/plugins/workflow/status/snapshot.ts";

export type ServiceCall = { readonly method: string; readonly args: unknown };

/** 运行摘要：测试只写关心的字段，其余给中性默认值。 */
export function runSummary(partial: Partial<RunSummary> & Pick<RunSummary, "runId">): RunSummary {
  return {
    name: "AAW 轻量开发",
    title: partial.name ?? "AAW 轻量开发",
    workflowId: "aaw-dev",
    workflowVersion: "1.0.0",
    entry: "dev",
    entryLabel: "从需求开始",
    requirement: "",
    inputs: {},
    createdAt: null,
    updatedAt: null,
    status: "running",
    args: { workflowId: "aaw-dev", workflowRevision: "r1" },
    result: null,
    failure: null,
    ...partial,
  };
}

/** 工作流库条目：一个起点、一项必填需求。 */
export function workflowSummary(id = "aaw-dev", origin: "preset" | "user" = "preset"): WorkflowSummary {
  return {
    id,
    origin,
    diagnostics: [],
    meta: {
      id,
      name: id === "aaw-dev" ? "AAW 轻量开发" : id,
      version: "1.0.0",
      description: "测试用工作流",
      revision: "r1",
      entries: [{ id: "dev", label: "从需求开始", description: "输入需求", inputs: [{ name: "requirement", label: "本次需求", kind: "text", required: true, placeholder: "" }] }],
    },
  };
}

/**
 * 可编程的 WorkflowService 测试替身：面板/启动器用例按需投喂运行列表与
 * 每 runId 画布快照（面板目录取自快照的 catalog 字段），并记录服务调用
 * （authorizeRetry/reconcile/openSessionStream…）。事件经 emit 手动泵
 * （对齐真实服务的 subscribe 通道）。
 */
export function fakeWorkflowService() {
  let runs: readonly RunSummary[] = [];
  const snapshots = new Map<string, { state: CanvasSnapshot; listeners: Set<(state: CanvasSnapshot, previous: CanvasSnapshot) => void> }>();
  const calls: ServiceCall[] = [];
  const listeners = new Set<(event: WorkflowEvent) => void>();
  let disposed = false;
  let pendingFocus = "";
  let pendingLaunch: WorkflowLaunchRequest | null = null;
  let library: readonly WorkflowSummary[] = [workflowSummary()];
  const details = new Map<string, WorkflowDetail>();

  const service: WorkflowService = {
    isActive: () => !disposed,
    bindWorkspace: () => () => {},
    workflows: () => Promise.resolve(library),
    workflow: (id) => {
      const detail = details.get(id);
      if (detail) return Promise.resolve(detail);
      const summary = library.find((item) => item.id === id);
      if (!summary) return Promise.reject(new Error("WORKFLOW_NOT_FOUND"));
      return Promise.resolve({ ...summary, catalogs: {}, files: [{ path: "workflow.yaml", text: "id: " + id }] });
    },
    copyWorkflow: (id) => {
      calls.push({ method: "copyWorkflow", args: id });
      return Promise.resolve(`${id}-copy`);
    },
    deleteWorkflow: (id) => {
      calls.push({ method: "deleteWorkflow", args: id });
      return Promise.resolve();
    },
    start: (request) => {
      calls.push({ method: "start", args: request });
      return Promise.resolve({ runId: "run-1" });
    },
    requestLaunch: (request) => {
      calls.push({ method: "requestLaunch", args: request });
      pendingLaunch = request;
      listeners.forEach((listener) => listener({ type: "focus-launch", runId: "" }));
    },
    takeLaunchRequest: () => {
      const request = pendingLaunch;
      pendingLaunch = null;
      return request;
    },
    resume: async (runId) => {
      calls.push({ method: "resume", args: runId });
    },
    recover: async (runId, reason) => {
      calls.push({ method: "recover", args: { runId, reason } });
    },
    refresh: async () => {
      calls.push({ method: "refresh", args: null });
    },
    runs: () => runs,
    sessionLinks: () => ({ workspace: null, runs: [] }),
    focusRun: (runId) => {
      calls.push({ method: "focusRun", args: runId });
      pendingFocus = runId;
      listeners.forEach((listener) => listener({ type: "focus-run", runId }));
    },
    takeFocusRun: () => {
      const runId = pendingFocus;
      pendingFocus = "";
      return runId;
    },
    snapshot: (runId) => {
      let store = snapshots.get(runId);
      if (store === undefined) {
        store = { state: emptyCanvasSnapshot(), listeners: new Set() };
        snapshots.set(runId, store);
      }
      const bound = store;
      return {
        getState: () => bound.state,
        getInitialState: () => bound.state,
        subscribe: (listener) => {
          bound.listeners.add(listener);
          return () => {
            bound.listeners.delete(listener);
          };
        },
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    authorizeRetry: async (runId, site, evidence) => {
      calls.push({ method: "authorizeRetry", args: { runId, site, evidence } });
    },
    reconcile: async (runId, site, resolution) => {
      calls.push({ method: "reconcile", args: { runId, site, resolution } });
    },
    stop: async (runId) => {
      calls.push({ method: "stop", args: runId });
    },
  };

  return {
    service,
    calls,
    emit(event: WorkflowEvent): void {
      listeners.forEach((listener) => listener(event));
    },
    setLibrary(next: readonly WorkflowSummary[]): void {
      library = next;
    },
    setDetail(detail: WorkflowDetail): void {
      details.set(detail.id, detail);
    },
    setRuns(next: readonly RunSummary[]): void {
      runs = next;
      listeners.forEach((listener) => listener({ type: "runs-changed", runId: "" }));
    },
    setSnapshot(runId: string, next: CanvasSnapshot): void {
      const store = snapshots.get(runId);
      if (store === undefined) {
        snapshots.set(runId, { state: next, listeners: new Set() });
        return;
      }
      const previous = store.state;
      store.state = next;
      store.listeners.forEach((listener) => listener(next, previous));
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
    },
  };
}

export type FakeWorkflowService = ReturnType<typeof fakeWorkflowService>;
