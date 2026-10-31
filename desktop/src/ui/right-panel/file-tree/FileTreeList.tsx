/**
 * 虚拟列表容器（对齐 ZCode WorkspaceFileTreeList.tsx）：role=tree、
 * 错误/加载/空态分流、吸顶行遮罩 mask——mask 位置由原生 scroll 回调直接写
 * CSS 变量同步（透明→hiddenHeight 的渐变遮住从吸顶层下经过的原行）。
 */
import type { CSSProperties, RefCallback } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { AlertCircleIcon, FilesIcon, LoaderCircleIcon } from "./icons.tsx";
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
    return <FileTreeNotice icon={<FilesIcon className="size-4" />} title={emptyTitle} />;
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
          {rows.map((row) => renderRow(row, {}, "static"))}
        </div>
      )}
    </div>
  );
}
