/**
 * 文件条目的图标和名称。开合、选中及行尾状态由各场景的行容器负责。
 */
import { Fragment } from "react";
import { FolderGlyph } from "../icons.tsx";
import { FileDisplayIcon } from "./fileDisplay.tsx";
import { resolveIconName } from "./fileDisplayHelpers.ts";

export function FileEntryLabel({
  name,
  folder,
  nameClassName = "",
}: {
  readonly name: string;
  /** 提供开合状态时使用文件夹图标。 */
  readonly folder?: "open" | "closed";
  readonly nameClassName?: string;
}) {
  const segments = folder ? name.split("/") : [name];
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {folder ? (
        <FolderGlyph
          isExpanded={folder === "open"}
          className="ui-icon-16 shrink-0 text-ink-mute"
        />
      ) : (
        <FileDisplayIcon
          name={resolveIconName(name)}
          className="ui-icon-16 shrink-0"
        />
      )}
      <span
        data-file-entry-name=""
        className={`min-w-0 flex-1 truncate ${nameClassName}`}
      >
        {segments.map((segment, index) => (
          <Fragment key={`${segment}-${index}`}>
            {index > 0 && <span className="mx-0.5 text-ink-subtlest">/</span>}
            {segment}
          </Fragment>
        ))}
      </span>
    </span>
  );
}
