import { expect, test, type Locator } from "@playwright/test";
import { color } from "./contrast.ts";

const fixture =
  "/tests/visual/sessionStatusOverlayFixture.html?right-panel&workbench";
const leftToggleName = "展开/收起侧边栏";

test("入口未读徽标保留完整的无障碍计数，进入侧栏时保持未读", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 650 });
  await page.goto(`${fixture}&activity-rail&unread`);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const conversations = rail.getByRole("button", { name: "会话" });
  await expect(conversations).toHaveAccessibleDescription("101 项未读");
  await expect(conversations.getByText("99+")).toBeVisible();
  if (await conversations.getAttribute("aria-expanded") !== "true") await conversations.click();
  await expect(conversations).toHaveAccessibleDescription("101 项未读");
  await page.getByRole("button", { name: "查看会话" }).click();
  await expect(conversations.getByText("99+")).toHaveCount(0);
  await expect(conversations).not.toHaveAttribute("aria-description");
});

test("侧栏底部在两套主题下保留提醒和账号菜单，并在键盘开合时接续焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 500, height: 600 });
  await workspace.goto(`${fixture}&activity-rail&appearance&storage-notice`);
  const footer = workspace.getByRole("complementary", { name: "存储提醒" });
  const notice = footer.locator("[data-sidebar-footer-row]");
  const sizeLabel = notice.getByText("1234567.0/100 MiB", { exact: true });
  const rail = workspace.getByRole("navigation", { name: "工作台导航" });
  const account = rail.getByRole("button", { name: "打开账号菜单" });
  await expect(sizeLabel).toBeVisible();
  await account.press("Enter");
  const menu = workspace.getByRole("menu", { name: "账号菜单" });
  const settings = menu.getByRole("menuitem", { name: "设置" });
  await menu.press("ArrowDown");
  await expect(settings).toBeFocused();

  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workspace.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(settings).toBeFocused();
    await expect(sizeLabel).toBeVisible();
    expect(
      await notice.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await settings.press("Escape");
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();
  await expect(account).not.toHaveCSS("box-shadow", "none");

  const collapse = workspace.getByRole("button", {
    name: leftToggleName,
    expanded: true,
  });
  const expand = workspace.getByRole("button", {
    name: leftToggleName,
    expanded: false,
  });
  await collapse.press("Enter");
  await expect(expand).toBeFocused();
  await expect(expand).not.toHaveCSS("box-shadow", "none");
  await expand.press("Enter");
  await expect(collapse).toBeFocused();
  await expect(sizeLabel).toBeVisible();
  await notice.getByRole("button", { name: "管理" }).press("Enter");
  await expect(workspace.locator("html")).toHaveAttribute(
    "data-opened-storage",
    "true",
  );
  await expect(notice).toBeHidden();
});

test("活动栏在两种主题和三档字号下保持键盘焦点与当前入口", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 720, height: 650 });
  await workspace.goto(`${fixture}&activity-rail&appearance`);
  const rail = workspace.getByRole("navigation", { name: "工作台导航" });
  const mark = rail.getByTestId("workbench-mark");
  const wordmark = workspace.getByTestId("workbench-wordmark");
  const resizer = workspace.getByRole("separator", { name: "调整左栏宽度" });
  await expect(mark).toHaveAttribute(
    "src",
    /(?:^data:image\/svg\+xml,|aaw-logo-rail\.svg)/,
  );
  await expect
    .poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const workflow = rail.getByRole("button", { name: "工作流" });
  await workflow.press("Enter");
  await expect(workflow).toHaveAttribute("aria-current", "location");
  await expect(workflow).toHaveAttribute("aria-expanded", "true");
  await expect(workspace.getByText("当前项目的工作流")).toBeVisible();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px, brand, style] of [
    ["暖白", 12, "Awesome Agent WorkSpace", "italic"],
    ["暗夜", 20, "AAW", "normal"],
    ["暖白", 14, "Awesome Agent WorkSpace", "italic"],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workspace.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(workflow).toBeFocused();
    await expect(workflow).toHaveAttribute("aria-current", "location");
    await expect(workflow).toHaveAttribute("aria-expanded", "true");
    await expect(workflow).not.toHaveCSS("box-shadow", "none");
    await expect
      .poll(() => color(workflow, "background-color"))
      .toEqual(await color(workflow, "--color-selected"));
    await expect
      .poll(() =>
        workflow
          .locator("svg")
          .evaluate((icon) => parseFloat(getComputedStyle(icon).width)),
      )
      .toBeCloseTo((18 * px) / 14, 1);
    expect((await workflow.boundingBox())!.width).toBe(36);
    const markBounds = (await mark.boundingBox())!;
    expect(markBounds.width).toBeCloseTo((28 * px) / 14, 1);
    expect(markBounds.height).toBeCloseTo(markBounds.width, 1);
    await expect(wordmark).toHaveText(brand);
    await expect(wordmark).toHaveCSS("font-style", style);
    if (px === 20) {
      await expect(wordmark).toHaveCSS("font-weight", "600");
      await resizer.press("End");
      await expect(wordmark).toHaveText("Awesome Agent WorkSpace");
      await expect(wordmark).toHaveCSS("font-style", "italic");
      await resizer.press("Home");
      await expect(wordmark).toHaveText("AAW");
      await workflow.focus();
    }
  }
  await workflow.press("Space");
  await expect(workflow).toHaveAttribute("aria-expanded", "false");
  await expect(workflow).toHaveAttribute("aria-current", "location");
  await expect(workflow).toBeFocused();
});

test("the activity rail has a full-height divider and keeps icons in place on collapse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(`${fixture}&activity-rail`);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const drawer = page.locator('[data-edge-drawer="left"]');
  await expect(drawer).toHaveCSS("border-radius", "0px");
  const entries = rail.getByTestId("activity-rail-entries");
  const conversations = entries.getByRole("button", { name: "会话" });
  const workflows = entries.getByRole("button", { name: "工作流" });
  const settings = rail.getByRole("button", { name: "设置" });
  const logo = entries.getByTestId("workbench-mark");
  const divider = rail.getByTestId("workbench-sidebar-divider");
  const header = drawer.getByRole("button", { name: leftToggleName });
  const origin = (await conversations.boundingBox())!;
  const headerBox = (await header.locator("..").boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const entriesBox = (await entries.boundingBox())!;
  const drawerBox = (await drawer.boundingBox())!;
  const listBox = (await drawer.getByText("项目和会话列表").boundingBox())!;
  const dividerBox = (await divider.boundingBox())!;
  const logoBox = (await logo.boundingBox())!;
  const wordmark = drawer.getByTestId("workbench-wordmark");
  await expect(wordmark).toHaveText("Awesome Agent WorkSpace");
  const titleBox = (await wordmark.boundingBox())!;
  const headerSeam = page.getByTestId("sidebar-header-seam");
  const headerSeamBox = (await headerSeam.boundingBox())!;
  const account = rail.getByRole("button", { name: "打开账号菜单" });
  const warningBox = (await drawer.getByRole("status").boundingBox())!;
  const accountBox = (await account.boundingBox())!;
  const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;
  const centerY = (box: { y: number; height: number }) =>
    box.y + box.height / 2;
  expect(origin.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  expect(railBox.x).toBeCloseTo(drawerBox.x, 0);
  expect(titleBox.x).toBeCloseTo(listBox.x, 0);
  expect(headerBox.width).toBeCloseTo(drawerBox.width, 0);
  expect(centerX(logoBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerX((await workflows.boundingBox())!)).toBeCloseTo(
    centerX(origin),
    0,
  );
  expect(centerX(entriesBox)).toBeCloseTo(centerX(origin), 0);
  await expect(entries).toHaveCSS("box-shadow", "none");
  await expect(entries).toHaveCSS("border-radius", "0px");
  const settingsBox = (await settings.boundingBox())!;
  expect(centerX(settingsBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerX(accountBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerY(settingsBox)).toBeLessThan(centerY(accountBox));
  const warningRow = (await drawer
    .locator("[data-sidebar-footer-row]")
    .boundingBox())!;
  expect(centerY(warningRow)).toBeCloseTo(centerY(accountBox), 0);
  expect(
    drawerBox.y + drawerBox.height - warningRow.y - warningRow.height,
  ).toBeCloseTo(8, 0);
  expect(
    railBox.y + railBox.height - accountBox.y - accountBox.height,
  ).toBeCloseTo(8, 0);
  expect(warningBox.y + warningBox.height).toBeCloseTo(
    drawerBox.y + drawerBox.height,
    0,
  );
  expect(headerSeamBox.y).toBeCloseTo(headerBox.y + headerBox.height, 0);
  expect(headerSeamBox.x).toBeCloseTo(railBox.x + railBox.width, 0);
  expect(headerSeamBox.width).toBeCloseTo(drawerBox.width - railBox.width, 0);
  expect(dividerBox.y).toBeCloseTo(railBox.y, 0);
  expect(dividerBox.y + dividerBox.height).toBeCloseTo(
    drawerBox.y + drawerBox.height,
    0,
  );
  expect(dividerBox.x + dividerBox.width).toBeCloseTo(
    railBox.x + railBox.width,
    0,
  );
  expect(dividerBox.width).toBe(1);
  await expect(divider).toHaveCSS("opacity", "1");

  await conversations.click();
  await expect(drawer).toBeHidden();
  await expect(conversations).toHaveAttribute("aria-expanded", "false");
  expect(await conversations.boundingBox()).toEqual(origin);
  expect(await logo.boundingBox()).toEqual(logoBox);
  await expect(
    page.locator('[data-testid="workbench-mark"], img[src*="aaw-logo"]'),
  ).toHaveCount(1);
  await expect(divider).toHaveCSS("opacity", "0");
  await expect(headerSeam).toHaveCSS("width", "0px");
  expect(await entries.boundingBox()).toEqual(entriesBox);
  expect(await account.boundingBox()).toEqual(accountBox);
  await account.click();
  await expect(page.getByRole("menu", { name: "账号菜单" })).toBeVisible();
  await page.keyboard.press("Escape");
  await workflows.click();
  await expect(drawer.getByText("当前项目的工作流")).toBeVisible();
  await expect(workflows).toHaveAttribute("aria-expanded", "true");
  await expect(settings).toBeVisible();
  await expect(divider).toHaveCSS("opacity", "1");
});

async function sampleTrajectory(trigger: Locator, side: "left" | "right") {
  return trigger.evaluate(async (button, side) => {
    const drawer = document.querySelector<HTMLElement>(
      `[data-edge-drawer="${side}"]`,
    )!;
    const parent = drawer.parentElement!;
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    (button as HTMLButtonElement).click();
    await nextFrame();
    // Force style calculation before inspecting the generated CSS transition.
    drawer.getBoundingClientRect();
    const transition = drawer
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "translate",
      );
    if (!transition?.effect)
      throw new Error("Expected the shared drawer transition");
    transition.pause();
    const duration = transition.effect.getComputedTiming().activeDuration;
    if (typeof duration !== "number")
      throw new Error("Expected a time-based drawer transition");
    const measurement = (fraction: number) => {
      transition.currentTime = duration * fraction;
      const { left, right } = drawer.getBoundingClientRect();
      const owner = parent.getBoundingClientRect();
      return Math.round(
        side === "left" ? right - owner.left : owner.right - left,
      );
    };
    const samples = [measurement(0), measurement(0.4), measurement(0.99)];
    transition.play();
    return samples;
  }, side);
}

for (const [side, width] of [
  ["left", 1480],
  ["right", 1480],
  ["right", 595],
] as const) {
  test(`${side} drawer at ${width}px moves in and out through its own edge`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(fixture);
    const drawer = page.locator(`[data-edge-drawer="${side}"]`);
    const toggle =
      side === "left"
        ? page.getByRole("button", { name: leftToggleName })
        : page.getByTestId("side-pane-toggle");
    if (side === "left") await toggle.click();
    await expect(drawer).toBeHidden();

    const [entry, entering, open] = await sampleTrajectory(toggle, side);
    expect(Math.abs(entry!)).toBeLessThanOrEqual(2);
    expect(entering!).toBeGreaterThan(20);
    expect(open!).toBeGreaterThan(entering!);
    await expect(drawer).toBeVisible();
    await expect(drawer).not.toHaveAttribute("data-edge-drawer-sliding");
    const [departure, leaving, exit] = await sampleTrajectory(toggle, side);
    expect(departure!).toBeGreaterThan(leaving!);
    expect(leaving!).toBeGreaterThan(0);
    expect(Math.abs(exit!)).toBeLessThanOrEqual(2);
    await expect(drawer).toBeHidden();
  });
}

test("reversing the right drawer before it settles preserves its open content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(fixture);
  const toggle = page.getByTestId("side-pane-toggle");
  await toggle.evaluate(async (button) => {
    const click = () => (button as HTMLButtonElement).click();
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    click();
    await nextFrame();
    await nextFrame();
    click();
    await nextFrame();
    await nextFrame();
    click();
  });
  const drawer = page.locator('[data-edge-drawer="right"]');
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute("inert");
  await expect(drawer).not.toHaveAttribute("data-edge-drawer-sliding");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(drawer.getByLabel("搜索文件")).toBeVisible();
});

test("the right drawer stays on its edge when the left sidebar moves the workspace across the overlay breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 800 });
  await page.goto(fixture);
  const offsets = await page
    .getByTestId("side-pane-toggle")
    .evaluate(async (button, leftToggleName) => {
      const left = document.querySelector<HTMLButtonElement>(
        `[data-edge-drawer="left"] button[aria-label="${leftToggleName}"]`,
      )!;
      const right = document.querySelector<HTMLElement>(
        '[data-edge-drawer="right"]',
      )!;
      left.click();
      (button as HTMLButtonElement).click();
      const offsets = [];
      for (let frame = 0; frame < 24; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        offsets.push(
          right.getBoundingClientRect().right -
            right.parentElement!.getBoundingClientRect().right,
        );
      }
      return offsets;
    }, leftToggleName);
  expect(offsets.some((offset) => offset > 10)).toBe(true);
  expect(offsets.every((offset) => offset >= -1)).toBe(true);
  await expect(page.locator('[data-edge-drawer="right"]')).not.toHaveAttribute(
    "data-edge-drawer-sliding",
  );
});

test("both drawer surfaces settle immediately with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(fixture);
  for (const side of ["left", "right"] as const) {
    const drawer = page.locator(`[data-edge-drawer="${side}"]`);
    const toggle =
      side === "left"
        ? page.getByRole("button", { name: leftToggleName })
        : page.getByTestId("side-pane-toggle");
    await toggle.click();
    if (side === "left") await expect(drawer).toBeHidden();
    else await expect(drawer).toBeVisible();
    await expect(drawer).not.toHaveAttribute("data-edge-drawer-sliding");
    expect(await drawer.evaluate((el) => el.getAnimations().length)).toBe(0);
  }
});
