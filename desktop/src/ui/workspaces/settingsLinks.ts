/** Workflow tool paths; Agent executable configuration belongs to its adapter. */
import {
  deriveAawScriptPath,
  type WorkspaceToolPaths,
} from "../../aaw/healthChecks.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";

/** 组装本次执行的工具路径覆盖（AAW 脚本）。 */
export function settingsPathsOverride(): Partial<WorkspaceToolPaths> {
  const { skillsSourceDir } = useSettingsStore.getState();
  const { toolPaths } = useWorkspaceStore.getState();
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
  const uvCommand = useWorkspaceStore((state) => state.toolPaths.uvCommand);
  const aawScriptPath = useWorkspaceStore(
    (state) => state.toolPaths.aawScriptPath,
  );

  return {
    uvCommand,
    aawScriptPath,
    setUvCommand: (command) => {
      const store = useWorkspaceStore.getState();
      store.setToolPaths({ ...store.toolPaths, uvCommand: command });
    },
    setAawScriptPath: (path) => {
      const store = useWorkspaceStore.getState();
      store.setToolPaths({ ...store.toolPaths, aawScriptPath: path });
    },
  };
}
