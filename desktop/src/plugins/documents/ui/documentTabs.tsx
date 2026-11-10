import type { PanelTab, PanelTabPresentation } from "../../workbench/types.ts";
import {
  isAbsolutePath,
  normalizePath,
  pathKey,
  pathName,
} from "../../../shared/panelPaths.ts";
import { FileDisplayIcon } from "../../../shared/ui/file-icons/fileDisplay.tsx";
import { resolveIconName } from "../../../shared/ui/file-icons/fileDisplayHelpers.ts";
import { FolderIcon } from "../../../shared/ui/file-icons/icons.tsx";

export function documentTab(
  path: string,
  directory: boolean,
  line?: number,
): PanelTab {
  const kind = directory ? "directory" : "file";
  return {
    id: `${kind}:${pathKey(path)}`,
    kind,
    data: {
      path: normalizePath(path),
      ...(!directory && line ? { line } : {}),
    },
  };
}

export function readDocumentTab(
  tab: PanelTab | undefined,
  kind: "file" | "directory",
) {
  if (
    tab?.kind !== kind ||
    typeof tab.data?.path !== "string" ||
    !isAbsolutePath(tab.data.path)
  )
    return undefined;
  const { path, line } = tab.data;
  return {
    path,
    line:
      typeof line === "number" && line > 0 && Number.isFinite(line)
        ? line
        : undefined,
  };
}

export function presentDocumentTab(
  tab: PanelTab,
): PanelTabPresentation | undefined {
  const kind = tab.kind;
  if (kind !== "file" && kind !== "directory") return undefined;
  const entry = readDocumentTab(tab, kind);
  if (!entry) return undefined;
  const { path } = entry;
  return {
    title: pathName(path),
    tooltip: path,
    searchHint: path,
    typeLabel: kind === "file" ? "文件预览" : "目录",
    icon:
      kind === "file" ? (
        <FileDisplayIcon
          name={resolveIconName(path)}
          size={14}
          className="shrink-0"
        />
      ) : (
        <FolderIcon className="size-3.5 shrink-0" />
      ),
  };
}
