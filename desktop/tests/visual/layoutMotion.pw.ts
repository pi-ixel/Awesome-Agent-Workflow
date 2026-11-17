import { expect, test, type Locator } from "@playwright/test";

async function widthTransition(locator: Locator, trigger: () => Promise<void>) {
  const before = await locator.evaluate((node) => node.getBoundingClientRect().width);
  await trigger();
  const widths = await locator.evaluate(async (node) => {
    const values: number[] = [];
    for (let frame = 0; frame < 18; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(node.getBoundingClientRect().width);
    }
    return values;
  });
  const after = widths.at(-1)!;
  expect(Math.abs(before - after)).toBeGreaterThan(50);
  expect(widths.some((width) => width > Math.min(before, after) + 10 && width < Math.max(before, after) - 10)).toBe(true);
}

test("layout edges move continuously, with the chat draft preserved through complete view", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  const main = page.locator("main");
  const nav = page.getByRole("button", { name: "切换项目栏" });
  const open = page.getByRole("button", { name: "打开文件栏" });
  await expect(page.locator(".session-status-mini")).toBeVisible();
  const statusFades = await nav.evaluate(async (button) => {
    if (button instanceof HTMLElement) button.click();
    const card = document.querySelector(".session-status-panel")!;
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const opacity = Number(getComputedStyle(card).opacity);
      if (opacity > 0 && opacity < 1) return true;
    }
    return false;
  });
  expect(statusFades).toBe(true);
  await expect(page.locator(".session-status-panel")).toBeVisible();
  await expect(page.locator(".session-status-panel")).toHaveCSS("opacity", "1");
  await widthTransition(main, () => nav.click());
  const reservation = page.locator(".workbench-right-reservation");
  await open.click();
  await expect(page.locator("[data-panel-slide]")).toHaveCount(0);
  const preview = page.getByLabel("预览区");
  await widthTransition(preview, () => page.getByRole("button", { name: "收起目录" }).click());
  await widthTransition(preview, () => page.getByRole("button", { name: "展开目录" }).click());
  await widthTransition(reservation, () => page.getByRole("button", { name: "进入完整视图" }).click());
  await expect(page.getByTestId("full-view-host")).toHaveAttribute("data-side-pane-full-view-host", "floating");
  await widthTransition(reservation, () => page.getByRole("button", { name: "退出完整视图" }).click());
  await expect(page.getByRole("textbox", { name: "草稿" })).toHaveValue("保留草稿");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "项目右侧工具栏" })).toBeHidden();
});

test("narrow panel uses a slide without reserving width, and reduced motion switches immediately", async ({ page }) => {
  await page.setViewportSize({ width: 580, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  const open = page.getByRole("button", { name: "打开文件栏" });
  const pane = page.locator('aside[aria-label="项目右侧工具栏"]');
  await expect(pane).toBeHidden();
  const slide = await open.evaluate((button) => {
    if (button instanceof HTMLElement) button.click();
    return new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const pane = document.querySelector('aside[aria-label="项目右侧工具栏"]')!;
      resolve(pane.getBoundingClientRect().right > window.innerWidth + 5);
    })));
  });
  expect(slide).toBe(true);
  await expect(page.locator(".workbench-right-reservation")).toHaveCSS("width", "0px");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Escape");
  await expect(pane).toHaveAttribute("hidden", "");
  await expect(pane).toHaveCSS("transition-duration", "0s");
});
