/**
 * 流程图画布的几何常量与「条带宽度随视口」的唯一算法。
 *
 * 从前这段 clamp 只在运行页算（RunView 自己量视口），详情页和草稿页直接把
 * BAND_MAX 传进去 —— 同一个画布，运行页里能跟着面板收窄，详情页里不能。
 * 现在由 GraphCanvas 统一量视口、统一算，页面只需把 bandWidth 交给内容。
 */

/** 条带宽度上下限（规约 §6.2）：低于下限宁可横向滚动，高于上限不再拉长。 */
export const BAND_MIN = 380;
export const BAND_MAX = 430;
/** 画布左右内边距与右侧回环导轨宽度（条带可用宽 = 视口 − 内边距×2 − 导轨）。 */
export const CANVAS_PAD = 20;
export const LOOP_GUTTER = 40;

/** 条带宽度：可用宽 = 视口 − 内边距×2 − 回环导轨，再 clamp 到上下限。 */
export function bandWidthFor(viewportWidth: number): number {
  const available = viewportWidth - CANVAS_PAD * 2 - LOOP_GUTTER;
  return Math.round(Math.max(BAND_MIN, Math.min(BAND_MAX, available > 0 ? available : BAND_MAX)));
}

/** 面板比「最小条带 + 两侧内边距 + 导轨」还窄：条带保持最小宽、横向滚动，出提示。 */
export function isNarrow(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth < BAND_MIN + CANVAS_PAD * 2 + LOOP_GUTTER;
}
