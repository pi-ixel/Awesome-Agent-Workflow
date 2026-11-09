import { useStore } from "zustand";
import { createAawStatusStore } from "../../src/plugins/workflow/statusStore.ts";
import type { WorkflowService } from "../../src/contracts/workflow.ts";

export const workflowStatus = createAawStatusStore();

export const workflowTestService: WorkflowService = {
  status: workflowStatus,
  isActive: () => true,
  bindWorkspace: () => () => {},
  refresh: () => workflowStatus.getState().refresh(),
  selectSr: (sr) => workflowStatus.getState().selectSr(sr),
  setAutoRefresh: (enabled) => workflowStatus.getState().setAutoRefresh(enabled),
  submit: () => false,
};
export function workflowViewFixture() {
  return {
    useWorkbenchWorkflow: () => workflowTestService,
    useWorkflowStatus: <T>(
      select: (state: ReturnType<typeof workflowStatus.getState>) => T,
    ) => useStore(workflowStatus, select),
  };
}
