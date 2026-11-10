import type { ProcessRunner } from "../../host/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { WorkflowService } from "../service.ts";
import type { WorkflowWorkspace } from "../types.ts";
import { createAawStatusStore } from "./statusStore.ts";
import { createCliAawStatusLoader } from "./statusLoader.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export function createWorkflow(
  runner: ProcessRunner,
  submit: WorkflowService["submit"],
  logger?: Logger,
) {
  const status = createAawStatusStore(logger);
  const view = createSnapshotView(status, (state) => ({
    workspacePath: state.workspacePath,
    hasSource: state.hasSource,
    srs: state.srs,
    currentSr: state.currentSr,
    status: state.status,
    next: state.next,
    plan: state.plan,
    isLoading: state.isLoading,
    lastError: state.lastError,
    lastRefreshedAt: state.lastRefreshedAt,
    autoRefresh: state.autoRefresh,
  }));
  let binding = 0;
  let disposed = false;
  return {
    status: view.snapshot,
    isActive: () => !disposed,
    refresh: () => status.getState().refresh(),
    selectSr: (sr) => status.getState().selectSr(sr),
    setAutoRefresh: (enabled) => status.getState().setAutoRefresh(enabled),
    bindWorkspace(options: WorkflowWorkspace | null) {
      if (disposed) return () => {};
      const version = ++binding;
      status
        .getState()
        .bindLoader(
          options ? createCliAawStatusLoader({ ...options, runner }) : null,
          options?.workspacePath ?? null,
        );
      if (options) void status.getState().refresh();
      return () => {
        if (version !== binding || disposed) return;
        binding++;
        status.getState().bindLoader(null, null);
      };
    },
    submit(...args: Parameters<WorkflowService["submit"]>) {
      if (disposed) throw new Error("Workflow service is disposed");
      return submit(...args);
    },
    onSessionActivity(this: void, path, event) {
      const state = status.getState();
      if (state.workspacePath && pathKey(path) === pathKey(state.workspacePath))
        state.handleSessionEvent(event);
    },
    dispose(this: void) {
      disposed = true;
      view.dispose();
      status.dispose();
    },
  } satisfies WorkflowService & {
    onSessionActivity(this: void, path: string, event: AcpSessionEvent): void;
    dispose(this: void): void;
  };
}
