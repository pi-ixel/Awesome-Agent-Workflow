import { pathKey } from "../../../../shared/panelPaths.ts";
import { basenameOf } from "../../../../shared/workspaceText.ts";
import { emptyWorkspace } from "../../workspace/types.ts";
import type { WorkspaceSnapshot } from "../../types.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useProject } from "./projectView.tsx";

export function useWorkspaceService() {
  return useProject()?.projects.workspace;
}

export function useWorkspaceCommands() {
  return useProject()?.projects;
}

export function useWorkspaceValue<T>(
  select: (state: WorkspaceSnapshot) => T,
): T {
  const workspace = useWorkspaceService();
  return useRegisteredSnapshot(workspace, (state) =>
    select(state ?? emptyWorkspace),
  );
}

export function useProjectName(path: string): string {
  const name = useWorkspaceValue(
    (state) => state.projectFolders?.[pathKey(path)]?.name,
  );
  return name || basenameOf(path);
}
