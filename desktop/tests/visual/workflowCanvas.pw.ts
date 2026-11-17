import { test } from "@playwright/test";

/**
 * 画布外观截图（不在这里断言，断言在 vitest 里）：这只是把 workflowFixture
 * 渲染出来落盘成 PNG，供人工按报告逐条核对托盘层级、卡片、叠板、导轨与药丸。
 */
test("capture workflow canvas fixture", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1060 });
  await page.goto("/tests/visual/workflowFixture.html");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm.png", fullPage: true });
  const viewport = page.locator(".workflow-viewport");
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm-viewport.png" });
  await page.goto("/tests/visual/workflowFixture.html?theme=dark");
  await page.waitForTimeout(600);
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-dark-viewport.png" });
});
