/**
 * 虚拟列表容器（对齐 ZCode WorkspaceFileTreeList.tsx）：role=tree、
 * 错误/加载/空态分流、吸顶行遮罩 mask——mask 位置由原生 scroll 回调直接写
 * CSS 变量同步（透明→hiddenHeight 的渐变遮住从吸顶层下经过的原行）。
 */
import { useState, type CSSProperties, type RefCallback } from "react";
import { TreeBranch } from "../../../../shared/ui/TreeMotion.tsx";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  AlertCircleIcon,
  FilesIcon,
  LoaderCircleIcon,
} from "../../../../shared/ui/file-icons/icons.tsx";
import { FileTreeNotice } from "./Notice.tsx";
import {
  FileTreeRow as FileTreeRowView,
  type FileTreeRowHandlers,
} from "./FileTreeRow.tsx";
import {
  FILE_TREE_MASK_OFFSET_PROPERTY,
  getFileTreeListMaskStyle,
} from "./constants.ts";
import {
  getDirectoryGitStatuses,
  getRelativePath,
  type FileTreeGitStatus,
  type FileTreeRow,
} from "./model.ts";

interface StaticNode {
  row: FileTreeRow;
  children: StaticNode[];
}

/** Rebuild hierarchy from the visible pre-order rows without changing tree navigation. */
function nestRows(rows: readonly FileTreeRow[]): StaticNode[] {
  const roots: StaticNode[] = [];
  const stack: StaticNode[] = [];
  for (const row of rows) {
    while (stack.length && stack[stack.length - 1]!.row.depth >= row.depth)
      stack.pop();
    const node: StaticNode = { row, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (row.type === "directory") stack.push(node);
  }
  return roots;
}

function StaticBranch({
  node,
  renderRow,
}: {
  readonly node: StaticNode;
  readonly renderRow: (row: FileTreeRow) => React.ReactNode;
}) {
  const [lastChildren, setLastChildren] = useState(node.children);
  if (node.row.expanded && node.children !== lastChildren)
    setLastChildren(node.children);
  const children = node.row.expanded ? node.children : lastChildren;
  return (
    <>
      {renderRow(node.row)}
      {node.row.type === "directory" && (
        <TreeBranch open={node.row.expanded}>
          {children.map((child) => (
            <StaticBranch
              key={child.row.key}
              node={child}
              renderRow={renderRow}
            />
          ))}
        </TreeBranch>
      )}
    </>
  );
}

export function FileTreeList({
  rootError,
  showInitialLoading,
  rows,
  virtualItems,
  listRef,
  stickyFolderCount,
  totalSize,
  emptyTitle,
  title,
  root,
  selectedKey,
  gitStatusByPath,
  handlers,
  virtual,
}: {
  readonly rootError: string | null;
  readonly showInitialLoading: boolean;
  readonly rows: readonly FileTreeRow[];
  readonly virtualItems: VirtualItem[];
  readonly listRef: RefCallback<HTMLDivElement>;
  readonly stickyFolderCount: number;
  readonly totalSize: number;
  readonly emptyTitle: string;
  readonly title: string;
  readonly root: string;
  readonly selectedKey: string | null;
  readonly gitStatusByPath: ReadonlyMap<string, FileTreeGitStatus>;
  readonly handlers: FileTreeRowHandlers;
  /** 超阈值行数才虚拟化（desktop GitPanel 同款先例）：小列表平铺，
   *  也让 0 高度测试环境（jsdom）能正常断言行内容。 */
  readonly virtual: boolean;
}) {
  const [trackedRows, setTrackedRows] = useState(() => ({
    rows,
    previous: new Set(rows.map((row) => row.key)),
  }));
  let previousKeys = trackedRows.previous;
  if (trackedRows.rows !== rows) {
    previousKeys = new Set(trackedRows.rows.map((row) => row.key));
    setTrackedRows({ rows, previous: previousKeys });
  }
  if (rootError) {
    return (
      <FileTreeNotice
        icon={<AlertCircleIcon className="size-4" />}
        title="读取目录失败"
        description={rootError}
      />
    );
  }
  if (showInitialLoading) {
    return (
      <FileTreeNotice
        icon={<LoaderCircleIcon className="size-4 animate-spin" />}
        title="加载中..."
      />
    );
  }
  if (rows.length === 0) {
    return (
      <FileTreeNotice
        icon={<FilesIcon className="size-4" />}
        title={emptyTitle}
      />
    );
  }
  /** 虚拟分支传 height+translateY 且行保持默认绝对定位；静态分支必须显式
   *  layout="static"——FileTreeRow 默认 layout="absolute"（top-0 定位），
   *  静态行落到该包装会全部叠在列表原点（视觉坍缩：只见首行、容器高 0）。 */
  const renderRow = (
    row: FileTreeRow,
    style: CSSProperties,
    layout: "absolute" | "static",
  ) => (
    <FileTreeRowView
      key={row.key}
      layout={layout}
      row={row}
      animateEnter={virtual && !previousKeys.has(row.key)}
      style={style}
      selected={selectedKey !== null && selectedKey === row.key}
      gitStatus={gitStatusByPath.get(row.key) ?? null}
      directoryGitStatuses={
        row.type === "directory"
          ? getDirectoryGitStatuses(gitStatusByPath, row.key)
          : []
      }
      root={root}
      relativePath={getRelativePath(root, row.path)}
      handlers={handlers}
    />
  );
  const listStyle = {
    [FILE_TREE_MASK_OFFSET_PROPERTY]: "0px",
    height: virtual ? `${totalSize}px` : undefined,
    ...getFileTreeListMaskStyle(stickyFolderCount),
  } as CSSProperties;
  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={listStyle}
      role="tree"
      aria-label={title}
    >
      {virtual ? (
        virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) return null;
          return renderRow(
            row,
            {
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
            },
            "absolute",
          );
        })
      ) : (
        // px-1 对齐虚拟行包装（absolute + px-1）的水平几何：层级引导线、
        // 选中描边等以行盒为基准，两种模式必须同位（吸顶条同款先例）。
        <div className="w-full px-1">
          {nestRows(rows).map((node) => (
            <StaticBranch
              key={node.row.key}
              node={node}
              renderRow={(row) => renderRow(row, {}, "static")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
