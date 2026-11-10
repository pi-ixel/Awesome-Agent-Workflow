import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { SessionTarget } from "../project/types.ts";
import type { WorkflowStatusValues, WorkflowView, WorkflowWorkspace } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    workflow: WorkflowService;
    workflowUi: WorkflowView;
  }
}

export interface WorkflowService {
  readonly status: ReadonlySnapshot<WorkflowStatusValues>;
  isActive(): boolean;
  bindWorkspace(options: WorkflowWorkspace | null): () => void;
  refresh(): Promise<void>;
  selectSr(sr: string): void;
  setAutoRefresh(enabled: boolean): void;
  submit(target: SessionTarget, prompt: string, queued?: boolean): boolean;
}

export { deriveStepPhases } from "./status/stepPhases.ts";
