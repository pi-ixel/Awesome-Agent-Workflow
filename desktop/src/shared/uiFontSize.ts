/**
 * 界面字号控制（复刻 ZCode 的方案）：
 *
 * 全站字号刻度不是一堆固定 px,而是挂在一个基准变量 `--ui-font-size` 上
 * （index.css 的 text-2xs/xs/sm/md/title 全部 calc 派生）。这里只负责该
 * 基准变量的取值与下发：
 *
 * - 取值范围 12–20px,取整夹取（越界/非法一律回落默认 14）；
 * - Workbench 写入根元素的变量，保留图标、间距和圆角的 rem 基准。
 */

export const DEFAULT_UI_FONT_SIZE_PX = 14;
export const MIN_UI_FONT_SIZE_PX = 12;
export const MAX_UI_FONT_SIZE_PX = 20;

/** 非法/越界值一律取整夹取回合法区间（NaN 回落默认 14）。 */
export function normalizeUiFontSizePx(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(
        MAX_UI_FONT_SIZE_PX,
        Math.max(MIN_UI_FONT_SIZE_PX, Math.round(value)),
      )
    : DEFAULT_UI_FONT_SIZE_PX;
}
