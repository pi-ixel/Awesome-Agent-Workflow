import { expect, test } from "@playwright/test";

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

test("工具栏空闲时淡化，导航摘要跟随界面字号", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html");
  const toolbar = page.getByRole("toolbar", { name: "画布工具" });
  await expect(toolbar).toHaveCSS("opacity", "0.65");
  await toolbar.getByRole("button").first().focus();
  await expect(toolbar).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "展开流程导航" }).click();
  const summary = page.getByText(/这一层 .* 个节点已结束/);
  const initialSize = await summary.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ui-font-size", "20px");
  });
  await expect.poll(() => summary.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(initialSize);
});

test("窄面板大字号时可打开指定轮次，详情操作在面板内换行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?inspector");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ui-font-size", "20px");
  });
  await page.getByRole("button", { name: /打开「.*」第 18 轮会话/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened-session", "session-18");

  await page.getByRole("button", { name: /检查工作流节点的长标题.*运行中/ }).click();
  const inspector = page.getByRole("complementary", { name: "节点详情" });
  await expect(inspector.getByRole("button", { name: "返回流程图" })).toBeVisible();
  const actions = inspector.locator(".workflow-inspector-actions");
  const overflows = await actions.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflows).toBe(false);
  await inspector.getByRole("button", { name: "第 1 轮", exact: true }).click();
  await inspector.getByRole("button", { name: "打开本轮会话" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened-session", "session-1");
  await inspector.screenshot({ path: "node_modules/.cache/aaw-workflow-ui-inspector.png" });
});
