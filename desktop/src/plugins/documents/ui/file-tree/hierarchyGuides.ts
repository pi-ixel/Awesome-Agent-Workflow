/**
 * 层级引导线（对齐 ZCode hierarchyGuides.ts）：repeating-linear-gradient
 * 每 12px 缩进列画一条 1px --color-border 竖线；线上下各延伸 1px。
 */
import type { CSSProperties } from "react";

const HIERARCHY_GUIDE_BACKGROUND =
  "repeating-linear-gradient(to right, transparent 0 calc(0.375rem - 1px), var(--color-border) calc(0.375rem - 1px) 0.375rem, transparent 0.375rem 0.75rem)";

export function getHierarchyGuideStyle(depth: number): CSSProperties | null {
  if (depth <= 0) return null;
  return {
    width: `calc(${depth} * 0.75rem)`,
    backgroundImage: HIERARCHY_GUIDE_BACKGROUND,
  };
}
