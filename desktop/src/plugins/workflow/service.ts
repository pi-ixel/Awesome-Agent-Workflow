import type { ProcessRunner } from "../../contracts/processRunner.ts";
import type {
  WorkflowService,
  WorkflowWorkspace,
} from "../../contracts/workflow.ts";
import { createAawStatusStore } from "./statusStore.ts";
import { createCliAawStatusLoader } from "./statusLoader.ts";

export function createWorkflow(
  runner: ProcessRunner,
  submit: WorkflowService["submit"],
) {
  const status = createAawStatusStore();
  let binding = 0;
  let disposed = false;
  return {
    status,
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
    dispose() {
      disposed = true;
      status.dispose();
    },
  } satisfies WorkflowService & { dispose(): void };
}
