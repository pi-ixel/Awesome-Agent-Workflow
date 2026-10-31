/**
 * 吸顶目录条（对齐 ZCode WorkspaceFileTreeStickyFolders.tsx:54-95）：
 * sticky top-0 z-10 h-0 overflow-visible，static 行包在 overflow-hidden
 * rounded-lg 内；原行永远保留在虚拟列表里，这里只是视觉覆盖。
 */
import { FileTreeRow as FileTreeRowView, type FileTreeRowHandlers } from "./FileTreeRow.tsx";
import {
  getDirectoryGitStatuses,
  getRelativePath,
  type FileTreeGitStatus,
  type FileTreeRow,
} from "./model.ts";
import type { StickyFolderItem } from "./useStickyFolders.ts";

export function FileTreeStickyFolders({
  items,
  selectedKey,
  gitStatusByPath,
  root,
  handlers,
  onRevealRow,
}: {
  readonly items: readonly StickyFolderItem[];
  readonly selectedKey: string | null;
  readonly gitStatusByPath: ReadonlyMap<string, FileTreeGitStatus>;
  readonly root: string;
  readonly handlers: FileTreeRowHandlers;
  readonly onRevealRow: (item: StickyFolderItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1">
      <div className="pointer-events-auto overflow-hidden rounded-lg">
        {items.map((item) => {
          const row = item.row;
          const handleToggle = (nextRow: FileTreeRow) => {
            handlers.onToggleDirectory(nextRow);
            if (nextRow.expanded) {
              requestAnimationFrame(() => onRevealRow(item));
            }
          };
          return (
            <FileTreeRowView
              key={row.key}
              layout="static"
              row={row}
              style={{}}
              selected={selectedKey !== null && selectedKey === row.key}
              gitStatus={gitStatusByPath.get(row.key) ?? null}
              directoryGitStatuses={getDirectoryGitStatuses(
                gitStatusByPath,
                row.key,
              )}
              root={root}
              relativePath={getRelativePath(root, row.path)}
              handlers={{ ...handlers, onToggleDirectory: handleToggle }}
            />
          );
        })}
      </div>
    </div>
  );
}
