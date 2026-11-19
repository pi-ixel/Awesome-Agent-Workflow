import { expect, it } from "vitest";
import { BAND_MAX, BAND_MIN, CANVAS_PAD, LOOP_GUTTER, bandWidthFor, isNarrow } from "../../../src/plugins/workflow/ui/canvasGeometry.ts";

/**
 * 条带宽度只有一份算法（GraphCanvas 算，三个页面共用）。
 * 从前只有运行页量视口，详情页和草稿页传常量，窄面板里直接溢出。
 */
it("clamps the band to the viewport, and only widens when the panel is narrow", () => {
  expect(bandWidthFor(1200)).toBe(BAND_MAX);
  expect(bandWidthFor(520)).toBe(BAND_MAX);
  // 584 − 20×2 − 40 = 504 → 仍超过上限；480 − 80 = 400 落在区间内。
  expect(bandWidthFor(480)).toBe(400);
  expect(bandWidthFor(400)).toBe(BAND_MIN);
  expect(bandWidthFor(0)).toBe(BAND_MAX);
});

it("calls a panel narrow only below the minimum band plus padding and rail", () => {
  const threshold = BAND_MIN + CANVAS_PAD * 2 + LOOP_GUTTER;
  expect(isNarrow(threshold - 1)).toBe(true);
  expect(isNarrow(threshold)).toBe(false);
  // 还没量出宽度时（首帧）不算窄：别在面板刚挂上时闪一条提示。
  expect(isNarrow(0)).toBe(false);
});
