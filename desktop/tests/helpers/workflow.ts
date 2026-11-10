import { createAawStatusStore } from "../../src/plugins/workflow/status/statusStore.ts";
import type { WorkflowService } from "../../src/plugins/workflow/service.ts";

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
