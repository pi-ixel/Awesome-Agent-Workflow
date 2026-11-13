import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import type {
  CanvasSnapshot,
  RunSummary,
  WorkflowService,
} from "../../../src/plugins/workflow/types.ts";
import { emptyCanvasSnapshot } from "../../../src/plugins/workflow/status/snapshot.ts";

export type ServiceCall = { readonly method: string; readonly args: unknown };

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

  const service: WorkflowService = {
    isActive: () => !disposed,
    bindWorkspace: () => () => {},
    startDev: async (requirement, entry) => {
      calls.push({ method: "startDev", args: { requirement, entry } });
      return { runId: "run-1" };
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
