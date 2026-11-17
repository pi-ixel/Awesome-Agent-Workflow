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

test("the gear focuses the shared tree placement preference and both folder views follow it", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  const tree = page.getByRole("tree");
  const row = tree.getByRole("treeitem", { name: "README.md" });
  const preview = page.getByLabel("预览区");
  const gear = page.getByRole("button", { name: "文件树设置" });
  const collapse = page.getByRole("button", { name: "收起目录" });
  await row.click();
  await expect(preview.getByRole("heading", { name: "文件视图示例" })).toBeVisible();
  expect((await tree.boundingBox())!.x).toBeGreaterThan((await preview.boundingBox())!.x);
  expect((await collapse.boundingBox())!.x).toBeGreaterThan((await gear.boundingBox())!.x);
  const separator = page.getByRole("separator", { name: "调整目录列宽度" });
  const leftEdge = (await separator.boundingBox())!.x;
  await separator.press("ArrowLeft");
  await expect.poll(async () => (await separator.boundingBox())!.x).toBeLessThan(leftEdge);

  await gear.click();
  const position = page.getByRole("group", { name: "文件树位置" });
  await expect(position.getByRole("button", { name: "右侧" })).toBeFocused();
  await position.getByRole("button", { name: "左侧" }).click();
  await page.keyboard.press("Escape");
  await expect(gear).toBeFocused();
  expect((await tree.boundingBox())!.x).toBeLessThan((await preview.boundingBox())!.x);
  expect((await collapse.boundingBox())!.x).toBeLessThan((await gear.boundingBox())!.x);
  await expect(preview.getByRole("heading", { name: "文件视图示例" })).toBeVisible();
  await widthTransition(preview, () => collapse.click());
  await widthTransition(preview, () => page.getByRole("button", { name: "展开目录" }).click());

  await page.getByRole("button", { name: "打开目录标签" }).click();
  await expect(tree.getByRole("treeitem", { name: "README.md" })).toBeVisible();
  expect((await tree.boundingBox())!.x).toBeLessThan((await preview.boundingBox())!.x);
  expect((await collapse.boundingBox())!.x).toBeLessThan((await gear.boundingBox())!.x);
});

test("file view options move between the toolbar and the More menu with header width", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const views = page.getByRole("group", { name: "文件视图" });
  await expect(views.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
  await views.getByRole("button", { name: "源码" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Markdown 源码编辑器" })).toBeVisible();

  const header = page.locator("[data-file-manager-header]");
  await header.evaluate((el) => { (el as HTMLElement).style.maxWidth = "300px"; });
  await expect(views).toHaveCount(0);
  const breadcrumb = page.getByRole("navigation", { name: "文件路径" });
  await expect(breadcrumb).toHaveCSS("scrollbar-width", "none");
  await expect.poll(() => breadcrumb.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await breadcrumb.evaluate((el) => { el.scrollLeft = 0; });
  await expect.poll(() => breadcrumb.evaluate((el) => el.scrollLeft)).toBe(0);
  await header.getByRole("button", { name: "更多" }).click();
  const more = page.getByRole("menu", { name: "更多" });
  await expect(more.getByRole("menuitemradio", { name: "源码" })).toHaveAttribute("aria-checked", "true");
  await more.getByRole("menuitemradio", { name: "预览" }).click();
  await expect(page.getByRole("heading", { name: "文件视图示例" })).toBeVisible();
  await header.evaluate((el) => { (el as HTMLElement).style.maxWidth = ""; });
  await expect(views.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
});

test("file find floats above the document and keeps the query when switching to source and back", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const title = page.getByRole("heading", { name: "文件视图示例" });
  const originalBox = await title.boundingBox();
  await page.getByRole("button", { name: "搜索文件" }).click();
  const find = page.getByRole("dialog", { name: "文件查找" });
  const query = find.getByRole("textbox", { name: "搜索当前文件" });
  const count = find.locator('[aria-live="polite"]');
  await expect(query).toBeFocused();
  expect(await title.boundingBox()).toEqual(originalBox);
  await query.fill("alpha");
  await expect(count).toHaveText("1/3");
  await query.press("Enter");
  await expect(count).toHaveText("2/3");

  await page.getByRole("button", { name: "源码", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect(query).toHaveValue("alpha");
  await expect(count).toHaveText(/\/3$/);
  await expect(editor.locator(".cm-searchMatch")).toHaveCount(3);
  await expect(find.getByRole("textbox", { name: "替换为" })).toBeHidden();
  await find.getByRole("button", { name: "更多查找选项" }).click();
  await page.getByRole("menuitemcheckbox", { name: "区分大小写" }).click();
  await expect(count).toHaveText(/\/2$/);
  await find.getByRole("button", { name: "替换", exact: true }).click();
  await find.getByRole("textbox", { name: "替换为" }).fill("beta");
  await query.press("ArrowDown");
  await find.getByRole("button", { name: "替换当前" }).click();
  await expect(count).toHaveText(/\/1$/);
  await find.getByRole("button", { name: "全部替换" }).click();
  await expect(editor).toContainText("Alpha beta beta");
  await expect(count).toHaveText("0/0");

  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(query).toHaveValue("alpha");
  await expect(count).toHaveText("1/1");
  await expect(find.getByRole("textbox", { name: "替换为" })).toBeHidden();
  await query.press("Escape");
  await expect(find).toBeHidden();
  await expect(page.getByLabel("预览区")).toBeVisible();
});

test("outline uses a single bulk button and animates nested branches and the whole column", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const title = page.getByRole("heading", { name: "文件视图示例" });
  const toggle = page.getByRole("button", { name: "大纲", exact: true });
  await widthTransition(title, () => toggle.click());
  const outline = page.getByRole("navigation", { name: "文件大纲" });
  await outline.getByRole("button", { name: "全部展开" }).click();
  await expect(outline.getByRole("button", { name: "小节", exact: true })).toBeVisible();
  await expect(outline.getByRole("button", { name: "全部展开" })).toHaveCount(0);
  const heights = await outline.getByRole("button", { name: "折叠 第一节" }).evaluate(async (button) => {
    const branch = document.getElementById(button.getAttribute("aria-controls")!)!;
    const height = () => branch.getBoundingClientRect().height;
    height();
    await Promise.all(branch.getAnimations().map((animation) => animation.finished));
    const before = height();
    (button as HTMLButtonElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    height();
    const collapse = branch.getAnimations().find((animation) =>
      animation instanceof CSSTransition && animation.transitionProperty === "grid-template-rows",
    );
    if (!collapse) throw new Error("Expected the shared branch height transition");
    collapse.pause();
    collapse.currentTime = 90;
    const during = height();
    collapse.finish();
    return { before, during, after: height() };
  });
  expect(heights.during).toBeGreaterThan(0);
  expect(heights.during).toBeLessThan(heights.before);
  expect(heights.after).toBe(0);
  await outline.getByRole("button", { name: "全部展开" }).click();
  await outline.getByRole("button", { name: "全部折叠" }).click();
  await expect(outline.getByRole("button", { name: "第一节", exact: true })).toBeHidden();
  await widthTransition(title, () => toggle.click());
  await expect(outline).toBeHidden();
});

test("the outline respects reduced motion for branch and column folding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const toggle = page.getByRole("button", { name: "大纲", exact: true });
  await toggle.click();
  const outline = page.getByRole("navigation", { name: "文件大纲" });
  await expect(outline.locator(".tree-branch").first()).toHaveCSS("transition-duration", "0s");
  await outline.getByRole("button", { name: "展开 第一节" }).click();
  await expect(outline.getByRole("button", { name: "小节", exact: true })).toBeVisible();
  await toggle.click();
  await expect(outline).toBeHidden();
  expect(await toggle.getAttribute("aria-expanded")).toBe("false");
});
