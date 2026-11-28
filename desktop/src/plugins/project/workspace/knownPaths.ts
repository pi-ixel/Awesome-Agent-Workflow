import { pathKey } from "../../../shared/panelPaths.ts";

/** 启动动画和后台查询使用同一批项目路径。 */
export function knownWorkspacePaths(workspace: {
  selectedPath: string | null;
  activePath: string | null;
  pinnedPaths: readonly string[];
  recentWorkspaces: readonly { path: string }[];
}): string[] {
  const paths = new Map<string, string>();
  for (const path of [
    workspace.selectedPath,
    workspace.activePath,
    ...workspace.pinnedPaths,
    ...workspace.recentWorkspaces.map((entry) => entry.path),
  ]) {
    if (path?.trim() && !paths.has(pathKey(path)))
      paths.set(pathKey(path), path);
  }
  return [...paths.values()];
}
