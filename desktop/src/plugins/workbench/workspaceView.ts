import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from "../../contracts/workspace.ts";
import { useRegisteredSnapshot, useWorkbenchProject } from "./react.ts";

export function useWorkspaceService() {
  return useWorkbenchProject()?.workspace;
}

export function useWorkspaceValue<T>(
  select: (state: WorkspaceSnapshot) => T,
): T {
  const workspace = useWorkspaceService();
  return useRegisteredSnapshot(workspace, (state) =>
    select(state ?? emptyWorkspace),
  );
}
