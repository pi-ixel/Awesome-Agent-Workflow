import type { WorkbenchService } from "../../contracts/workbench.ts";
import type {
  WorkflowService,
  WorkflowWorkspace,
} from "../../contracts/workflow.ts";
import type { WorkspaceService } from "../../contracts/workspace.ts";
import { deriveAawScriptPath } from "../../shared/workflowPaths.ts";

export function bindWorkflowWorkspace(
  workflow: Pick<WorkflowService, "bindWorkspace">,
  workspace: WorkspaceService,
  workbench: WorkbenchService,
): () => void {
  const readSkillSource = () =>
    workbench.getSnapshot().skills[0]?.service.source;
  let source: ReturnType<typeof readSkillSource>;
  let stopSource: (() => void) | undefined;
  let stopQuery: (() => void) | undefined;
  let current: WorkflowWorkspace | null = null;

  function refreshBinding() {
    if (!workbench.navigationGuard.isActive()) return;
    const path = workbench.navigation.getState().contextPath;
    const { uvCommand, aawScriptPath } = workspace.getState().toolPaths;
    const script =
      aawScriptPath.trim() || deriveAawScriptPath(source?.getSnapshot() ?? "");
    const next =
      path === null
        ? null
        : { workspacePath: path, uvCommand, aawScriptPath: script };
    if (
      current?.workspacePath === next?.workspacePath &&
      current?.uvCommand === next?.uvCommand &&
      current?.aawScriptPath === next?.aawScriptPath
    )
      return;
    current = next;
    stopQuery = workflow.bindWorkspace(next);
  }

  function updateSkillSource() {
    const next = readSkillSource();
    if (source === next) return;
    stopSource?.();
    source = next;
    stopSource = source?.subscribe(refreshBinding);
    refreshBinding();
  }

  const stopWorkbench = workbench.subscribe(updateSkillSource);
  const stopNavigation = workbench.navigation.subscribe(refreshBinding);
  const stopWorkspace = workspace.subscribe(refreshBinding);
  updateSkillSource();
  refreshBinding();

  return () => {
    stopWorkbench();
    stopNavigation();
    stopWorkspace();
    stopSource?.();
    stopQuery?.();
  };
}
