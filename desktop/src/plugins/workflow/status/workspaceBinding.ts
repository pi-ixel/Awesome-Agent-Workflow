import type { WorkflowService } from "../service.ts";
import type { WorkflowWorkspace } from "../types.ts";
import type { WorkspaceView } from "../../project/types.ts";
import type { SkillsSource } from "../../skills/types.ts";
import { deriveAawScriptPath } from "../config.ts";

export function bindWorkflowWorkspace(
  workflow: Pick<WorkflowService, "bindWorkspace">,
  workspace: WorkspaceView,
  navigation: {
    isActive(): boolean;
    getPath(): string | null;
    subscribe(listener: () => void): () => void;
  },
) {
  let source: SkillsSource | undefined;
  let stopSource: (() => void) | undefined;
  let stopQuery: (() => void) | undefined;
  let current: WorkflowWorkspace | null = null;
  let disposed = false;

  function refreshBinding() {
    if (disposed || !navigation.isActive()) return;
    const path = navigation.getPath();
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

  function setSkillSource(next: SkillsSource | undefined) {
    if (disposed || source === next) return;
    stopSource?.();
    source = next;
    stopSource = source?.subscribe(refreshBinding);
    refreshBinding();
  }

  const stopNavigation = navigation.subscribe(refreshBinding);
  const stopWorkspace = workspace.subscribe(refreshBinding);
  refreshBinding();

  return {
    attachSkillSource(attached: SkillsSource) {
      setSkillSource(attached);
      return () => {
        if (source === attached) setSkillSource(undefined);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopNavigation();
      stopWorkspace();
      stopSource?.();
      stopQuery?.();
    },
  };
}
