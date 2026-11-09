/**
 * 栏宽的持久化与恢复（ColumnResizer 与 App 共用的纯逻辑）：
 *
 * - 栏宽经 CSS 变量注入 App 的 grid 模板（`var(--aaw-left-w, 320px)`）；
 * - 拖拽结果持久化到 localStorage，应用启动时在首帧前恢复
 *   由 Workbench Fiber 绑定，避免按默认宽渲染后再跳变。
 */

import type { HostStorage } from "../../../contracts/host.ts";
import { clampWidth, readColumnWidth } from "../../../shared/ui/controls/columnWidth.ts";

/** 左栏（项目树）宽度的 CSS 变量名与持久化键。 */
export const LEFT_WIDTH_VAR = "--aaw-left-w";
export const LEFT_WIDTH_STORAGE_KEY = "aaw-desktop/layout/zcode-v1/left-w";

/** 宽度默认值与钳制区间（px）。沿用原项目列表栏的区间（树的直接前身）。 */
export const LEFT_DEFAULT_PX = 264;
export const LEFT_MIN_PX = 264;
export const LEFT_MAX_PX = 480;

// 注：图标窄栏（原常驻 48px）已随 IconRail 组件退役——侧栏开关在树列
// 顶部拖拽带（收起后移入顶栏左端），App 的 grid 为三列（树列 / 拖宽热区 / 内容区）。

/** 首帧前恢复持久化栏宽，卸载时归还原有样式。 */
export function bindPersistedColumnWidths(
  root: HTMLElement,
  storage: HostStorage,
): () => void {
  const previous = root.style.getPropertyValue(LEFT_WIDTH_VAR);
  const priority = root.style.getPropertyPriority(LEFT_WIDTH_VAR);
  const left = readColumnWidth(storage, LEFT_WIDTH_STORAGE_KEY);
  if (left !== null) {
    const viewport =
      root.ownerDocument.defaultView?.innerWidth ?? LEFT_MIN_PX * 2;
    const width = clampWidth(
      left,
      LEFT_MIN_PX,
      Math.max(LEFT_MIN_PX, viewport * 0.5),
    );
    root.style.setProperty(LEFT_WIDTH_VAR, `${width}px`);
  }
  return () => {
    if (previous) root.style.setProperty(LEFT_WIDTH_VAR, previous, priority);
    else root.style.removeProperty(LEFT_WIDTH_VAR);
  };
}
