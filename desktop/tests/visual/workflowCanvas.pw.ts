import { expect, test } from "@playwright/test";

/**
 * 流程图外观截图（不在这里断言，断言在 vitest 里）：把 workflowFixture
 * 渲染出来，收起和展开第一个阶段各落盘一张 PNG，供人工核对。
 */
test("capture workflow canvas fixture", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1060 });
  await page.goto("/tests/visual/workflowFixture.html");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm.png", fullPage: true });
  const viewport = page.locator(".wf-flow");
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm-viewport.png" });
  await page.getByRole("button", { name: /展开步骤/ }).first().click();
  await page.waitForTimeout(1200);
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm-open.png" });
  await page.goto("/tests/visual/workflowFixture.html?theme=dark");
  await page.waitForTimeout(600);
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-dark-viewport.png" });
});

test("窄面板大字号时可打开指定轮次，详情操作在面板内换行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?inspector");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ui-font-size", "20px");
  });
  await page.getByRole("button", { name: /展开步骤/ }).first().click();
  await page.getByRole("button", { name: /打开「.*」第 18 轮会话/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened-session", "session-18");

  await page.getByRole("button", { name: /检查工作流节点的长标题.*运行中/ }).click();
  const inspector = page.getByRole("complementary", { name: "节点详情" });
  const actions = inspector.locator(".workflow-inspector-actions");
  const overflows = await actions.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflows).toBe(false);
  await inspector.getByRole("button", { name: "第 1 轮", exact: true }).click();
  await inspector.getByRole("button", { name: "打开本轮会话" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened-session", "session-1");
  await inspector.screenshot({ path: "node_modules/.cache/aaw-workflow-ui-inspector.png" });
});

test("窄栏首页并列显示工作流库和运行管理，返回时保留筛选", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?panel");
  const nav = page.getByRole("tablist", { name: "工作流面板" });
  await expect(nav.getByRole("tab", { name: "工作流库" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "预置工作流" })).toBeVisible();
  await nav.getByRole("tab", { name: "运行管理" }).click();
  const manager = page.getByRole("region", { name: "运行管理" });
  await expect(manager.getByRole("region", { name: "待处理" })).toContainText("确认设计方案");
  await expect(manager.getByRole("region", { name: "运行记录" })).toContainText("整理交接记录");
  await manager.getByRole("searchbox").fill("交接");
  await expect(manager.getByRole("region", { name: "待处理" })).toHaveCount(0);
  await manager.getByRole("button", { name: /查看运行 整理交接记录/ }).click();
  await expect(nav).toHaveCount(0);
  await page.getByRole("navigation", { name: "位置" }).getByRole("button", { name: "运行管理" }).click();
  await expect(manager.getByRole("searchbox")).toHaveValue("交接");
  expect(await manager.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
