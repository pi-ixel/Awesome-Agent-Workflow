/**
 * 文件树单行渲染（对齐 ZCode WorkspaceFileTreeRowView.tsx:210-333；token
 * 换算：foreground→ink、subtlest→ink-subtlest，text-ui-base 两边同名同源
 * --ui-font-size，不换算）：
 *
 * - 行高 28px（h-7 py-1）、text-ui-base、rounded-lg、默认透明 border（选中 =
 *   灰 pill 底；悬停 = surface-hover；省略 border 会让行高/对齐差 1px）；
 * - 左缩进 = depth*12px + 8px（CSS 变量驱动），depth>0 画层级引导线；
 * - 目录无文件夹图标，只有 size-3 ChevronRight（展开 rotate-90）；
 * - Git：行名全色、行尾字母 /70（无定宽列）、目录圆点 /60（loading 时隐藏圆点）；
 * - deleted 虚拟行不可拖拽、点击/Enter 只选中不打开。
 */
import {
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronRightIcon } from "../../icons.tsx";
import { AlertCircleIcon, LoaderCircleIcon } from "./icons.tsx";
import { FileDisplayIcon } from "./fileDisplay.tsx";
import { resolveIconName } from "./fileDisplayHelpers.ts";
import { FILE_TREE_DRAG_MIME } from "./constants.ts";
import { getHierarchyGuideStyle } from "./hierarchyGuides.ts";
import { buildFileMentionMarkdown } from "./helpers.ts";
import {
  getGitStatusDotClass,
  getGitStatusIndicator,
  getGitStatusIndicatorClass,
  getGitStatusTextClass,
  GIT_STATUS_LABELS,
} from "./statusStyles.ts";
import { FileTreeRowName } from "./RowName.tsx";
import type { FileTreeGitStatus, FileTreeRow } from "./model.ts";

export interface FileTreeRowHandlers {
  onSelect: (row: FileTreeRow) => void;
  onToggleDirectory: (row: FileTreeRow) => void;
  onOpenFile: (row: FileTreeRow) => void;
  onOpenContextMenu: (row: FileTreeRow, x: number, y: number) => void;
  onKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
    row: FileTreeRow,
  ) => void;
}

export function FileTreeRow({
  layout = "absolute",
  row,
  style,
  selected,
  gitStatus,
  directoryGitStatuses,
  root,
  relativePath,
  handlers,
}: {
  readonly layout?: "absolute" | "static";
  readonly row: FileTreeRow;
  /** 绝对布局传虚拟定位（height+translateY）；吸顶等静态布局传 {}。 */
  readonly style?: CSSProperties;
  readonly selected: boolean;
  readonly gitStatus: FileTreeGitStatus | null;
  readonly directoryGitStatuses: readonly FileTreeGitStatus[];
  readonly root: string;
  readonly relativePath: string;
  readonly handlers: FileTreeRowHandlers;
}) {
  const [dragging, setDragging] = useState(false);
  const isDirectory = row.type === "directory";
  const isDeleted = !isDirectory && gitStatus === "deleted";
  const rowStyle = {
    ...style,
    "--workspace-file-tree-depth": row.depth,
  } as CSSProperties;
  const guideStyle = getHierarchyGuideStyle(row.depth);
  // 文件图标：内联彩色 SVG（16 viewBox 品牌色线稿）；目录无图标只留 chevron。
  const fileIconName = isDirectory ? null : resolveIconName(row.path);
  const statusLabel = gitStatus ? GIT_STATUS_LABELS[gitStatus] : null;
  const indicator = gitStatus ? getGitStatusIndicator(gitStatus) : null;
  const indicatorClass = gitStatus
    ? getGitStatusIndicatorClass(gitStatus)
    : null;
  // 目录名文字色 = 自身状态 ?? 聚合第一优先级（statusStyles.ts:41-51）。
  const displayStatus = gitStatus ?? directoryGitStatuses[0];
  const nameStatusClass = displayStatus
    ? getGitStatusTextClass(displayStatus)
    : null;
  // 目录 loading 中已有 spinner，继续显示聚合圆点会让状态含义混在一起。
  const firstDescendantStatus = directoryGitStatuses[0];
  const showDirectoryDots =
    !row.loading && firstDescendantStatus !== undefined;

  const handleRowClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    handlers.onSelect(row);
    // 双击（event.detail>1）只保留选中：主要动作用单击执行。
    if (event.detail > 1) return;
    if (isDirectory) {
      handlers.onToggleDirectory(row);
      return;
    }
    if (isDeleted) return;
    handlers.onOpenFile(row);
  };

  const rowElement = (
    <div
      role="treeitem"
      aria-expanded={isDirectory ? row.expanded : undefined}
      tabIndex={0}
      draggable={!isDeleted}
      title={relativePath}
      className={[
        // ZCode 原规格（WorkspaceFileTreeRowView :225-232）：行盒 28px
        //（h-7 py-1）、字号 text-ui-base（14px，随 --ui-font-size 可调档缩放）、
        // 图标 size-4 / chevron size-3；选中态 = 灰色圆角 pill 底（border 恒
        // 透明，无描边）。
        "relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg border pr-2 py-1 text-left text-ui-base text-ink outline-none transition-[background-color,border-color,box-shadow]",
        isDeleted ? "cursor-default" : "cursor-pointer",
        "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
        selected
          ? "border-transparent bg-surface-hover hover:bg-surface-hover"
          : "border-transparent hover:bg-surface-hover",
        "focus-visible:border-line-strong",
      ].join(" ")}
      onClick={handleRowClick}
      onContextMenu={(event) => {
        handlers.onSelect(row);
        handlers.onOpenContextMenu(row, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (isDeleted && event.key === "Enter") {
          // deleted 虚拟行的 Enter 与点击同拍：只选中不打开。
          event.preventDefault();
          handlers.onSelect(row);
          return;
        }
        handlers.onKeyDown(event, row);
      }}
      onDragStart={(event) => {
        if (isDeleted) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          FILE_TREE_DRAG_MIME,
          JSON.stringify({
            type: isDirectory ? "directory" : "file",
            workspacePath: root,
            path: row.path,
            relativePath,
            name: row.name,
          }),
        );
        event.dataTransfer.setData(
          "text/plain",
          buildFileMentionMarkdown(relativePath, row.name),
        );
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      {guideStyle && !dragging ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-y-px left-2.5"
          style={guideStyle}
        />
      ) : null}
      {isDirectory ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-subtle">
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3 text-ink-subtlest transition-transform ${
              row.expanded ? "rotate-90" : ""
            }`}
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {fileIconName ? (
          <FileDisplayIcon name={fileIconName} className="size-4 shrink-0" />
        ) : null}
        <FileTreeRowName
          name={row.name}
          className={`min-w-0 flex-1 truncate ${nameStatusClass ?? ""}`}
          slashClassName="mx-1 text-ink-subtlest"
        />
      </span>
      {indicator !== null && statusLabel !== null ? (
        <span
          title={statusLabel}
          aria-label={statusLabel}
          // ZCode 同位同色：行尾状态标记（U/M/A/D/R，无定宽列，font-bold）。
          className={`ml-auto inline-flex shrink-0 items-center justify-center font-mono text-ui-base font-bold leading-none ${indicatorClass ?? ""}`}
        >
          {indicator}
        </span>
      ) : null}
      {showDirectoryDots ? (
        <span
          title={directoryGitStatuses
            .map((status) => GIT_STATUS_LABELS[status])
            .join(", ")}
          aria-label="●"
          className="ml-1 flex shrink-0 items-center"
        >
          <span
            className={`size-1.5 rounded-full ${firstDescendantStatus ? getGitStatusDotClass(firstDescendantStatus) : ""}`}
          />
        </span>
      ) : null}
      {row.loading ? (
        <LoaderCircleIcon className="ml-2 size-3 shrink-0 animate-spin text-ink-subtlest" />
      ) : row.error ? (
        <AlertCircleIcon className="ml-2 size-3 shrink-0 text-warn" />
      ) : null}
    </div>
  );

  return (
    <div
      className={
        layout === "absolute" ? "absolute left-0 top-0 w-full px-1" : "w-full"
      }
      style={rowStyle}
    >
      {rowElement}
    </div>
  );
}
