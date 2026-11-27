import type { ReactNode } from "react";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { FolderGlyph, PlusIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import {
  basenameOf,
  formatCopyablePath,
} from "../../../shared/workspaceText.ts";

export function ProjectFolderFields({
  name,
  folders,
  device,
  isEditing,
  hideName,
  disabled,
  onNameChange,
  onFoldersChange,
  onPick,
}: {
  readonly name: string;
  readonly folders: readonly string[];
  readonly device: ReactNode;
  readonly isEditing: boolean;
  readonly hideName?: boolean;
  readonly disabled: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onFoldersChange?: (folders: readonly string[]) => void;
  readonly onPick?: () => void;
}) {
  return (
    <>
      {!hideName && (
        <div className="flex items-center overflow-hidden rounded-control border border-line-strong bg-surface">
          <span
            aria-hidden="true"
            className="flex min-h-10 w-10 shrink-0 items-center justify-center border-r border-line text-ink-mute"
          >
            <FolderGlyph className="ui-icon-16" />
          </span>
          <input
            type="text"
            disabled={disabled}
            aria-label="项目名称"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="项目名称"
            className={`${fieldSurfaceClass} min-h-10 min-w-0 flex-1 rounded-flat border-0 bg-transparent px-3 py-1.5 text-ui-sm`}
          />
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2 text-ui-sm text-ink-mute">
          <span>源文件夹</span>
          {device}
        </div>
        <div className="overflow-hidden rounded-popover border border-line-strong bg-surface">
          <ul
            aria-label="源文件夹"
            className="max-h-[min(240px,32dvh)] divide-y divide-line overflow-y-auto"
          >
            {folders.map((path, index) => (
              <li
                key={pathKey(path)}
                className="flex min-h-14 items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-raised text-ink-mute">
                  <FolderGlyph className="ui-icon-16" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm text-ink">
                    {basenameOf(path)}
                  </span>
                  <span
                    className="block truncate text-ui-caption text-ink-mute"
                    data-hint={formatCopyablePath(path)}
                  >
                    {formatCopyablePath(path)}
                  </span>
                </span>
                {index === 0 ? (
                  <span className="shrink-0 rounded-pill bg-raised px-2 py-1 text-ui-caption text-ink-mute">
                    主要
                  </span>
                ) : !isEditing && onFoldersChange ? (
                  <ActionButton
                    type="button"
                    tone="secondary"
                    disabled={disabled}
                    aria-label={`设 ${basenameOf(path)} 为主要目录`}
                    className="shrink-0 px-2 py-1 text-ui-xs"
                    onClick={() =>
                      onFoldersChange([
                        path,
                        ...folders.filter((_, i) => i !== index),
                      ])
                    }
                  >
                    设为主要
                  </ActionButton>
                ) : null}
                {onFoldersChange && (!isEditing || index > 0) && (
                  <IconButton
                    type="button"
                    iconSize="compact"
                    disabled={disabled}
                    aria-label={`移除 ${basenameOf(path)}`}
                    onClick={() =>
                      onFoldersChange(folders.filter((_, i) => i !== index))
                    }
                  >
                    <XIcon className="ui-icon-14" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          {onPick && (
            <ActionButton
              type="button"
              tone="ghost"
              disabled={disabled}
              onClick={onPick}
              className={`w-full gap-2 rounded-flat px-3 py-2 text-ui-sm text-ink-mute ${folders.length ? "border-t border-line" : ""}`}
              leadingIcon={<PlusIcon className="ui-icon-14 shrink-0" />}
              align="start"
            >
              添加文件夹
            </ActionButton>
          )}
        </div>
      </div>
    </>
  );
}
