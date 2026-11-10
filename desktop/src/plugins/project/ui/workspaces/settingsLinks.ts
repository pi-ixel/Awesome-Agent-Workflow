/** Workflow tool paths; Agent executable configuration belongs to its adapter. */
import type { WorkspaceToolPaths } from "../../workspace/types.ts";
import { deriveAawScriptPath } from "../../../workflow/service.ts";
import { useWorkspaceValue, useWorkspaceCommands } from "../bindings/workspaceView.ts";

/** 组装本次执行的工具路径覆盖（AAW 脚本）。 */
export function settingsPathsOverride(
  toolPaths: WorkspaceToolPaths,
  skillsSourceDir: string,
): Partial<WorkspaceToolPaths> {
  return {
    aawScriptPath:
      toolPaths.aawScriptPath.trim() !== ""
        ? toolPaths.aawScriptPath
        : deriveAawScriptPath(skillsSourceDir),
  };
}

/** 设置页「工具路径」区块的读写面：工作流路径配置。 */
export interface ToolPathSettings {
  readonly uvCommand: string;
  readonly aawScriptPath: string;
  readonly setUvCommand: (command: string) => void;
  readonly setAawScriptPath: (path: string) => void;
}

export function useToolPathSettings(): ToolPathSettings {
  const patchToolPaths = useWorkspaceCommands()?.patchToolPaths;
  const uvCommand = useWorkspaceValue((state) => state.toolPaths.uvCommand);
  const aawScriptPath = useWorkspaceValue(
    (state) => state.toolPaths.aawScriptPath,
  );

  return {
    uvCommand,
    aawScriptPath,
    setUvCommand: (uvCommand) => patchToolPaths?.({ uvCommand }),
    setAawScriptPath: (aawScriptPath) => patchToolPaths?.({ aawScriptPath }),
  };
}
