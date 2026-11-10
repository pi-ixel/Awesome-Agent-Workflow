import type { WorkflowStatusValues } from "../types.ts";

export const emptyWorkflowStatus: Readonly<WorkflowStatusValues> = {
  workspacePath: null,
  hasSource: false,
  srs: [],
  currentSr: null,
  status: null,
  next: null,
  plan: null,
  isLoading: false,
  lastError: null,
  lastRefreshedAt: null,
  autoRefresh: true,
};
