import type { AawNextPayload, AawPlanPayload, AawWorkflowStatus } from "./status/models.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { ComponentType } from "react";

export type { AawNextPayload, AawStepView, AawWorkflowStatus } from "./status/models.ts";

export interface WorkflowStatusValues {
  readonly workspacePath: string | null;
  readonly hasSource: boolean;
  readonly srs: readonly string[];
  readonly currentSr: string | null;
  readonly status: AawWorkflowStatus | null;
  readonly next: AawNextPayload | null;
  readonly plan: AawPlanPayload | null;
  readonly isLoading: boolean;
  readonly lastError: string | null;
  readonly lastRefreshedAt: string | null;
  readonly autoRefresh: boolean;
}

export interface WorkflowWorkspace {
  readonly workspacePath: string;
  readonly uvCommand: string;
  readonly aawScriptPath: string;
}

export interface WorkflowEntryCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  run(this: void): void;
}

/** Capabilities of the installed Workflow views, revoked with their Fiber. */
export interface WorkflowView {
  readonly status: ReadonlySnapshot<WorkflowStatusValues>;
  readonly entries: readonly WorkflowEntryCommand[];
  readonly openProgress: (project: string) => void;
  readonly Overview: ComponentType;
  readonly timeline: {
    readonly View: ComponentType;
    readonly isExpanded: () => boolean;
  };
}
