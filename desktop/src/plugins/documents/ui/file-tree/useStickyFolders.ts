/**
 * 吸顶目录触发线（对齐 ZCode useWorkspaceFileTreeStickyFolders.ts:7-93）：
 * 每层 sticky 行都会把下一层触发线向下推 28px——只和 scrollTop 比较会让
 * 子目录晚吸顶。通过探测 sticky stack 下方的行，让计算触发线与 CSS sticky
 * 的 top 使用相同的累计偏移。原行保留在虚拟列表里，CSS sticky 只做视觉覆盖。
 */
import { useMemo } from "react";
import { FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "./constants.ts";
import type { FileTreeRow } from "./model.ts";

export interface StickyFolderItem {
  row: FileTreeRow;
  index: number;
}

export function getStickyFolders({
  rows,
  scrollOffset,
  enabled = true,
}: {
  rows: readonly FileTreeRow[];
  scrollOffset: number;
  enabled?: boolean;
}): StickyFolderItem[] {
  if (!enabled) return [];
  if (rows.length === 0 || scrollOffset <= 0.5) return [];

  let stickyItems: StickyFolderItem[] = [];
  for (let iteration = 0; iteration <= rows.length; iteration += 1) {
    const probeOffset =
      scrollOffset + stickyItems.length * FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
    const probeIndex = Math.min(
      rows.length - 1,
      Math.floor(probeOffset / FILE_TREE_VIRTUAL_ROW_HEIGHT_PX),
    );
    const probeRow = rows[probeIndex];
    if (!probeRow) return [];

    const ancestorItems: StickyFolderItem[] = [];
    const canStickProbeRow = probeRow.type === "directory" && probeRow.expanded;
    let stickyDepth = canStickProbeRow ? probeRow.depth : probeRow.depth - 1;
    for (
      let index = canStickProbeRow ? probeIndex : probeIndex - 1;
      index >= 0 && stickyDepth >= 0;
      index -= 1
    ) {
      const row = rows[index];
      if (!row || row.type !== "directory" || !row.expanded) continue;
      if (row.depth === stickyDepth) {
        ancestorItems.push({ row, index });
        stickyDepth = row.depth - 1;
      }
    }
    ancestorItems.reverse();

    const nextStickyItems = ancestorItems.filter((item, stickyIndex) => {
      const rowStart = item.index * FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      const stickyBoundary =
        scrollOffset + stickyIndex * FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      return rowStart <= stickyBoundary + 0.5;
    });
    if (nextStickyItems.length === stickyItems.length) {
      return nextStickyItems;
    }
    stickyItems = nextStickyItems;
  }
  return stickyItems;
}

export function useStickyFolders({
  rows,
  scrollOffset,
  enabled,
}: {
  rows: readonly FileTreeRow[];
  scrollOffset: number;
  enabled: boolean;
}): StickyFolderItem[] {
  return useMemo(
    () => getStickyFolders({ rows, scrollOffset, enabled }),
    [enabled, rows, scrollOffset],
  );
}
