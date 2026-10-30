import { pathKey } from "../../core/panelPaths.ts";

/** Shared by startup presentation and preparation so they wait for the same projects. */
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
