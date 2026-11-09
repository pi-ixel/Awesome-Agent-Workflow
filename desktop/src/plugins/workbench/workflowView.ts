import {
  emptyWorkflowStatus,
  type WorkflowStatusValues,
} from "../../contracts/workflow.ts";
import { useRegisteredSnapshot, useWorkbenchEntries } from "./react.ts";

export function useWorkbenchWorkflow() {
  return useWorkbenchEntries("workflow")[0]?.service;
}

export function useWorkflowStatus<T>(
  select: (state: Readonly<WorkflowStatusValues>) => T,
): T {
  return useRegisteredSnapshot(useWorkbenchWorkflow()?.status, (state) =>
    select(state ?? emptyWorkflowStatus),
  );
}
