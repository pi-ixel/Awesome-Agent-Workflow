import { treeRowEnterClass } from "../../../../shared/ui/TreeMotion.tsx";
import { focusVisibleRing, rowSelectedClass } from "../../../../shared/ui/controls.tsx";
/**
 * 文件树单行渲染（对齐 ZCode WorkspaceFileTreeRowView.tsx:210-333；token
 * 换算：foreground→ink、subtlest→ink-subtlest，text-ui-base 两边同名同源
 * --ui-font-size，不换算）：
 *
 * - 行高 28px，选中底色和键盘焦点复用共享变量；
 * - 左缩进 = depth*12px + 8px（CSS 变量驱动），depth>0 画层级引导线；
 * - 文件夹图标表示目录的开合状态；
 * - Git：行名全色、行尾字母 /70（无定宽列）、目录圆点 /60（loading 时隐藏圆点）；
 * - deleted 虚拟行不可拖拽、点击/Enter 只选中不打开。
 */
import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AlertCircleIcon } from "../../../../shared/ui/file-icons/icons.tsx";
import { Spinner } from "../../../../shared/ui/controls.tsx";
import { FileEntryLabel } from "../../../../shared/ui/file-icons/FileEntryLabel.tsx";
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
import type { FileTreeGitStatus, FileTreeRow } from "./model.ts";

export interface FileTreeRowHandlers {
  onSelect: (row: FileTreeRow) => void;
  onToggleDirectory: (row: FileTreeRow) => void;
  onOpenFile: (row: FileTreeRow) => void;
  onOpenContextMenu: (row: FileTreeRow, x: number, y: number) => void;
}

export function FileTreeRow({
  layout = "absolute",
  animateEnter = false,
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
  readonly animateEnter?: boolean;
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
      aria-selected={selected}
      tabIndex={0}
      draggable={!isDeleted}
      data-file-tree-key={row.key}
      data-hint={relativePath}
      className={[
        // ZCode 原规格（WorkspaceFileTreeRowView :225-232）：行盒 28px
        //（h-7）、字号 text-ui-base（随 --ui-font-size 调整）。
        animateEnter ? treeRowEnterClass : "",
        "relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-control border pr-2 text-left text-ui-base leading-tight text-ink outline-none transition-[background-color,border-color,box-shadow]",
        isDeleted ? "cursor-default" : "cursor-pointer",
        "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
        "border-transparent focus-visible:ring-inset",
        selected ? rowSelectedClass : "hover:bg-surface-hover",
        focusVisibleRing,
      ].join(" ")}
      onClick={handleRowClick}
      onContextMenu={(event) => {
        handlers.onSelect(row);
        handlers.onOpenContextMenu(row, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          handlers.onOpenContextMenu(row, bounds.left, bounds.bottom);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          handlers.onSelect(row);
          if (isDirectory) handlers.onToggleDirectory(row);
          else if (!isDeleted) handlers.onOpenFile(row);
          return;
        }
        if (isDirectory && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
          event.preventDefault();
          const expand = event.key === "ArrowRight";
          if (row.expanded !== expand) {
            handlers.onSelect(row);
            handlers.onToggleDirectory(row);
          }
        }
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
      <FileEntryLabel
        name={row.name}
        folder={isDirectory ? (row.expanded ? "open" : "closed") : undefined}
        nameClassName={nameStatusClass ?? undefined}
      />
      {indicator !== null && statusLabel !== null ? (
        <span
          data-hint={statusLabel}
          aria-label={statusLabel}
          // ZCode 同位同色：行尾状态标记（U/M/A/D/R，无定宽列，font-bold）。
          className={`ml-auto inline-flex shrink-0 items-center justify-center font-mono text-ui-base font-bold leading-none ${indicatorClass ?? ""}`}
        >
          {indicator}
        </span>
      ) : null}
      {showDirectoryDots ? (
        <span
          data-hint={directoryGitStatuses
            .map((status) => GIT_STATUS_LABELS[status])
            .join(", ")}
          aria-label="●"
          className="ml-1 flex shrink-0 items-center"
        >
          <span
            className={`ui-icon-6 rounded-pill ${firstDescendantStatus ? getGitStatusDotClass(firstDescendantStatus) : ""}`}
          />
        </span>
      ) : null}
      {row.loading ? (
        <Spinner className="ml-2 ui-icon-12 shrink-0 text-ink-subtlest" />
      ) : row.error ? (
        <AlertCircleIcon className="ml-2 ui-icon-12 shrink-0 text-warn" />
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
