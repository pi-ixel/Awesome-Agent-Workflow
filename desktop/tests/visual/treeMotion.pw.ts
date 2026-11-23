import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";
test("tree branches animate and rapid reversal retains interaction state", async ({
  page,
}) => {
  await page.goto("/tests/visual/treeMotionFixture.html");
  const button = page.getByRole("button", { name: /目录/ });
  const branch = page.locator(".tree-branch").first();
  await expect(branch).toHaveAttribute("data-open", "false");
  await button.click();
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(branch).toHaveCSS("transition-duration", /0.18s/);
  await button.click();
  await expect(branch).toHaveAttribute("inert", "");
  await button.click();
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(page.getByText("子节点")).toBeVisible();
});
test("reduced motion removes tree animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/visual/treeMotionFixture.html");
  await expect(page.locator(".tree-branch").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await page.getByRole("button", { name: /目录/ }).click();
  const expanded = page.locator(".tree-branch").first();
  await expect(expanded).toHaveAttribute("data-open", "true");
  await expect(expanded).toHaveCSS("transition-duration", "0s");
  await expect(page.locator(".tree-chevron").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(page.locator(".tree-row-enter").first()).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("nonvirtual file directory uses shared height and opacity motion", async ({
  page,
}) => {
  await page.goto("/tests/visual/treeMotionFixture.html");
  const tree = page.getByRole("tree", { name: "文件" });
  const folder = tree.getByRole("treeitem", { name: /docs/ });
  const branch = tree.locator(".tree-branch");
  const glyph = folder.locator("svg");
  await expect(glyph).toHaveCount(1);
  const closedDrawing = await glyph.locator("path").getAttribute("d");
  await expect(branch).toHaveAttribute("data-open", "false");
  await folder.press("ArrowRight");
  await expect(branch).toHaveAttribute("data-open", "true");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(glyph.locator("path")).not.toHaveAttribute("d", closedDrawing!);
  await expect(folder).toBeFocused();
  await expect(branch).toHaveCSS("transition-duration", /0.18s/);
  await expect(tree.getByRole("treeitem", { name: /test.ts/ })).toBeVisible();
  await folder.press("ArrowLeft");
  await expect(branch).toHaveAttribute("data-open", "false");
  await expect(glyph.locator("path")).toHaveAttribute("d", closedDrawing!);
  await expect(branch).toHaveAttribute("inert", "");
  await folder.click();
  await expect(tree.getByRole("treeitem", { name: /test.ts/ })).toBeVisible();
});

test("项目树在切换外观时保留展开、当前会话和行内操作的键盘焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const sidebar = await context.newPage();
  await sidebar.emulateMedia({ reducedMotion: "reduce" });
  await sidebar.setViewportSize({ width: 288, height: 600 });
  await sidebar.goto("/tests/visual/treeMotionFixture.html?sessions");
  const tree = sidebar.getByRole("main", { name: "项目与会话" });
  const project = tree.getByRole("button", { name: "design-workbench" });
  await expect(project).toHaveAttribute("aria-current", "true");
  await project.press("Enter");
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await expect(project).toBeFocused();
  const actions = tree.getByRole("button", { name: "更多操作" });
  await expect(actions).toBeVisible();
  await sidebar.keyboard.press("Tab");
  await expect(actions).toBeFocused();
  await expect(actions).not.toHaveCSS("box-shadow", "none");
  await actions.press("Enter");
  const projectMenu = sidebar.getByRole("menu", { name: "项目菜单" });
  await expect(projectMenu).toBeFocused();
  await projectMenu.press("Escape");
  await expect(actions).toBeFocused();
  await project.press("Enter");
  const expanded = tree.getByRole("button", { name: "发布准备，2 个会话" });
  await expect(expanded).toHaveAttribute("aria-expanded", "false");
  await expanded.press("Enter");
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  const done = tree.getByRole("button", { name: "已完成的会话，1 个" });
  await done.press("Enter");
  const group = tree.getByRole("list", { name: "发布准备 的会话" });
  const session = group.getByRole("button", { name: "归档前复核" });
  await session.press("Enter");
  await expect(session).toHaveAttribute("aria-current", "true");
  await expect(project).not.toHaveAttribute("aria-current", "true");
  await expect(
    group.getByRole("button", {
      name: "归档任务（会话回合运行中，暂不可归档）",
    }),
  ).toBeDisabled();
  const row = session.locator("..");
  const star = row.getByRole("button", { name: "星标会话" });
  await session.press("Tab");
  await expect(star).toBeFocused();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    const title = session.getByText("归档前复核");
    await expect(title).toHaveCSS("font-size", px + "px");
    await expect(star).toBeFocused();
    await expect(star).toHaveCSS("opacity", "1");
    await expect(star).not.toHaveCSS("box-shadow", "none");
    await expect(session).toHaveAttribute("aria-current", "true");
    await expect(expanded).toHaveAttribute("aria-expanded", "true");
    await expect(done).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(async () =>
        Math.abs((await star.locator("svg").boundingBox())!.width - px),
      )
      .toBeLessThan(0.1);
    const backdrop = await color(tree, "background-color");
    const selectedToken = await color(row, "--color-selected");
    await expect.poll(() => color(row, "background-color")).toEqual(selectedToken);
    const selected = blend(selectedToken, backdrop);
    expect(ratio(await color(title, "color"), selected)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      ratio(await color(star, "--color-focus-ring"), selected),
    ).toBeGreaterThanOrEqual(3);
    expect(await tree.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      288,
    );
  }
  await star.press("Enter");
  await expect(
    row.getByRole("button", { name: "取消星标会话" }),
  ).toHaveAttribute("aria-pressed", "true");
  const archive = row.getByRole("button", { name: "归档任务" });
  await archive.press("Enter");
  const confirm = row.getByRole("button", { name: "确认归档" });
  await expect(confirm).toBeFocused();
  await confirm.press("Escape");
  await expect(archive).toBeFocused();
  await expect(session).toHaveAttribute("aria-current", "true");
});

test("侧栏右侧在运行圈与操作间切换，并跟随信息流颜色和字号", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const view = await context.newPage();
  await view.setViewportSize({ width: 820, height: 680 });
  await view.goto("/tests/visual/treeMotionFixture.html?sessions&running");
  const tree = view.getByRole("main", { name: "项目与会话" });
  const session = tree.getByRole("button", { name: /整理部署手册/ });
  const feed = view.getByRole("status", { name: "工作中" });
  const pinned = tree.getByRole("list", { name: "置顶任务" });
  await expect(pinned.getByRole("img", { name: "运行中" })).toBeVisible();
  await expect(session).toHaveCount(2);
  const projectSession = session.last();
  const row = projectSession.locator("..");
  const running = row.getByRole("img", { name: "运行中" });
  const star = row.getByRole("button", { name: "星标会话" });
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(view.locator("html")).toHaveCSS("--ui-font-size", `${px}px`);
    await expect(running).toBeVisible();
    const feedColor = await feed.locator("span").evaluate((el) => getComputedStyle(el).borderLeftColor);
    await expect(running.locator("span")).toHaveCSS("border-left-color", feedColor);
    expect((await running.boundingBox())!.width).toBeCloseTo(16 * px / 14, 1);
    const rowBox = (await row.boundingBox())!;
    const ringBox = (await running.boundingBox())!;
    expect(rowBox.x + rowBox.width - ringBox.x - ringBox.width).toBeLessThan(12);
  }

  await expect(star).toHaveCSS("opacity", "0");
  await projectSession.hover();
  await expect(running).toBeHidden();
  await expect(star).toHaveCSS("opacity", "1");
  await expect(feed).toBeVisible();
  await projectSession.click();
  await feed.hover();
  await expect(running).toBeVisible();
  await expect(star).toHaveCSS("opacity", "0");
  await view.keyboard.press("Tab");
  await expect(star).toBeFocused();
  await expect(star).toHaveCSS("opacity", "1");
  await expect(running).toBeHidden();

  await tree.getByRole("button", { name: "切换视角" }).click();
  await view.getByRole("menuitemradio", { name: "最近会话" }).click();
  await feed.hover();
  const recent = session.first().locator("..");
  const recentRunning = recent.getByRole("img", { name: "运行中" });
  await expect(recentRunning).toBeVisible();
  await session.first().hover();
  await expect(recentRunning).toBeHidden();
  await expect(recent.getByRole("button", { name: "星标会话" })).toHaveCSS("opacity", "1");
});

test("项目、置顶、最近和工作流分组的提示共用同一条右边线", async ({ page }) => {
  await page.setViewportSize({ width: 264, height: 620 });
  await page.goto("/tests/visual/treeMotionFixture.html?sessions&statuses");
  const tree = page.getByRole("main", { name: "项目与会话" });
  const pinned = tree.getByRole("list", { name: "置顶任务" });
  await expect(
    pinned.getByRole("img", { name: "失败", exact: true }),
  ).toBeVisible();
  await expect(
    pinned.getByRole("img", { name: "已完成，未查看" }),
  ).toBeVisible();
  const projectStatuses = tree.locator("[data-session-row-status]:visible");
  await expect(projectStatuses).toHaveCount(8);
  for (const text of ["待处理", "已停止", "等你回复", "等你处理"]) {
    await expect(projectStatuses.filter({ hasText: text })).toHaveCount(1);
  }
  const getStatusEdges = async () =>
    tree
      .locator("[data-session-row-status]:visible")
      .evaluateAll((slots) =>
        slots.map(
          (slot) => slot.lastElementChild!.getBoundingClientRect().right,
        ),
      );
  await expect
    .poll(async () => {
      const edges = await getStatusEdges();
      return Math.max(...edges) - Math.min(...edges);
    })
    .toBeLessThanOrEqual(1);

  const session = tree.getByRole("button", { name: /整理部署手册/ });
  const row = session.locator("..");
  await session.hover();
  await expect(row.getByText("待处理")).toBeHidden();
  await expect(row.getByRole("button", { name: "星标会话" })).toHaveCSS(
    "opacity",
    "1",
  );
  await page.mouse.move(1, 1);
  await expect(row.getByText("待处理")).toBeVisible();
  await expect(session).toHaveAccessibleDescription("待处理");

  const group = tree.getByRole("button", { name: "发布准备，2 个会话" });
  await group.hover();
  await expect(group.locator("..").getByText("等你回复")).toBeHidden();
  await expect(
    group.locator("..").getByRole("button", { name: "归档", exact: true }),
  ).toHaveCSS("opacity", "1");

  await tree.getByRole("button", { name: "切换视角" }).click();
  await page.getByRole("menuitemradio", { name: "最近会话" }).click();
  await page.mouse.move(1, 1);
  const recent = tree.getByRole("navigation", { name: "最近活跃会话" });
  await expect(recent.getByText("待处理")).toBeVisible();
  await expect(recent.getByText("等你处理")).toBeVisible();
  await expect
    .poll(async () => {
      const edges = await getStatusEdges();
      return Math.max(...edges) - Math.min(...edges);
    })
    .toBeLessThanOrEqual(1);
});

test("触屏侧栏同时显示行内操作和贴右的状态", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 264, height: 620 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/tests/visual/treeMotionFixture.html?sessions&statuses");
    const row = page
      .getByRole("button", { name: /整理部署手册/ })
      .locator("..");
    const hint = row.getByText("待处理");
    const action = row.getByRole("button", { name: "星标会话" });
    await expect(hint).toBeVisible();
    await expect(action).toHaveCSS("opacity", "1");
    const [hintBox, actionBox, rowBox] = await Promise.all([
      hint.boundingBox(),
      action.boundingBox(),
      row.boundingBox(),
    ]);
    expect(hintBox!.x).toBeGreaterThan(actionBox!.x + actionBox!.width);
    expect(rowBox!.x + rowBox!.width - hintBox!.x - hintBox!.width).toBeCloseTo(
      4,
      0,
    );
  } finally {
    await context.close();
  }
});

test("最近会话列表在行内重命名期间切换外观，保留草稿、选区和焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const sidebar = await context.newPage();
  await sidebar.setViewportSize({ width: 288, height: 600 });
  await sidebar.goto("/tests/visual/treeMotionFixture.html?sessions");
  await sidebar.getByRole("button", { name: "切换视角" }).press("Enter");
  await sidebar.getByRole("menuitemradio", { name: "最近会话" }).click();
  const recent = sidebar.getByRole("navigation", { name: "最近活跃会话" });
  const original = recent.getByRole("button", { name: /^整理部署手册/ });
  await original.press("Shift+F10");
  const menu = sidebar.getByRole("menu", { name: "会话菜单" });
  await expect(menu).toBeFocused();
  await menu.press("ArrowDown");
  await sidebar.keyboard.press("ArrowDown");
  await sidebar.keyboard.press("Enter");
  const field = recent.getByRole("textbox", { name: "重命名会话" });
  await field.fill("整理部署记录");
  await field.press("Home");
  await field.press("Shift+ArrowRight");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(field).toHaveCSS("font-size", px + "px");
    await expect(field).toHaveValue("整理部署记录");
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLInputElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, 1]);
  }
  await field.press("Enter");
  await expect(field).toBeHidden();
  await expect(
    recent.getByRole("button", { name: /^整理部署记录/ }),
  ).toBeVisible();
});
