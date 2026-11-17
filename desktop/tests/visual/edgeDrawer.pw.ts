import { expect, test, type Locator } from "@playwright/test";

const fixture = "/tests/visual/sessionStatusOverlayFixture.html?right-panel&workbench";
const leftToggleName = "展开/收起侧边栏";

test("the logo and activity icons share a frame that stays in place on collapse", async ({ page }) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(`${fixture}&activity-rail`);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const drawer = page.locator('[data-edge-drawer="left"]');
  const frame = rail.getByTestId("activity-rail-frame");
  const conversations = frame.getByRole("button", { name: "会话" });
  const workflows = frame.getByRole("button", { name: "工作流" });
  const settings = rail.getByRole("button", { name: "设置" });
  const logo = frame.getByTestId("workbench-mark");
  const divider = rail.getByTestId("workbench-sidebar-divider");
  const header = drawer.getByRole("button", { name: leftToggleName });
  const origin = (await conversations.boundingBox())!;
  const headerBox = (await header.locator("..").boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const frameBox = (await frame.boundingBox())!;
  const drawerBox = (await drawer.boundingBox())!;
  const listBox = (await drawer.getByText("项目和会话列表").boundingBox())!;
  const dividerBox = (await divider.boundingBox())!;
  const logoBox = (await logo.boundingBox())!;
  const titleBox = (await drawer.getByText("AAW", { exact: true }).boundingBox())!;
  const headerSeam = page.getByTestId("sidebar-header-seam");
  const headerSeamBox = (await headerSeam.boundingBox())!;
  const account = rail.getByRole("button", { name: "打开账号菜单" });
  const warningBox = (await drawer.getByRole("status").boundingBox())!;
  const accountBox = (await account.boundingBox())!;
  const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;
  const centerY = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(origin.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  expect(railBox.x).toBeCloseTo(drawerBox.x, 0);
  expect(titleBox.x).toBeCloseTo(listBox.x, 0);
  expect(headerBox.width).toBeCloseTo(drawerBox.width, 0);
  expect(centerX(logoBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerX((await workflows.boundingBox())!)).toBeCloseTo(centerX(origin), 0);
  expect(centerX(frameBox)).toBeCloseTo(centerX(origin), 0);
  await expect(frame).not.toHaveCSS("box-shadow", "none");
  const settingsBox = (await settings.boundingBox())!;
  expect(centerX(settingsBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerX(accountBox)).toBeCloseTo(centerX(origin), 0);
  expect(centerY(settingsBox)).toBeLessThan(centerY(accountBox));
  expect(warningBox.y + warningBox.height).toBeCloseTo(drawerBox.y + drawerBox.height, 0);
  expect(headerSeamBox.y).toBeCloseTo(headerBox.y + headerBox.height, 0);
  expect(headerSeamBox.x).toBeCloseTo(railBox.x + railBox.width, 0);
  expect(headerSeamBox.width).toBeCloseTo(drawerBox.width - railBox.width, 0);
  expect(dividerBox.y).toBeCloseTo(frameBox.y + frameBox.height, 0);
  expect(dividerBox.y + dividerBox.height).toBeCloseTo(drawerBox.y + drawerBox.height, 0);
  expect(dividerBox.x + dividerBox.width).toBeCloseTo(railBox.x + railBox.width, 0);
  expect(dividerBox.width).toBe(1);
  await expect(divider).toHaveCSS("opacity", "1");

  await conversations.click();
  await expect(drawer).toBeHidden();
  await expect(conversations).toHaveAttribute("aria-expanded", "false");
  expect(await conversations.boundingBox()).toEqual(origin);
  expect(await logo.boundingBox()).toEqual(logoBox);
  await expect(page.locator('img[src*="aaw-logo"]')).toHaveCount(1);
  await expect(divider).toHaveCSS("opacity", "0");
  await expect(headerSeam).toHaveCSS("width", "0px");
  expect(await frame.boundingBox()).toEqual(frameBox);
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
    const drawer = document.querySelector<HTMLElement>(`[data-edge-drawer="${side}"]`)!;
    const parent = drawer.parentElement!;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    (button as HTMLButtonElement).click();
    await nextFrame();
    // Force style calculation before inspecting the generated CSS transition.
    drawer.getBoundingClientRect();
    const transition = drawer.getAnimations().find((animation) =>
      animation instanceof CSSTransition && animation.transitionProperty === "translate",
    );
    if (!transition?.effect) throw new Error("Expected the shared drawer transition");
    transition.pause();
    const duration = transition.effect.getComputedTiming().activeDuration;
    if (typeof duration !== "number") throw new Error("Expected a time-based drawer transition");
    const measurement = (fraction: number) => {
      transition.currentTime = duration * fraction;
      const { left, right } = drawer.getBoundingClientRect();
      const owner = parent.getBoundingClientRect();
      return Math.round(side === "left" ? right - owner.left : owner.right - left);
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
  test(`${side} drawer at ${width}px moves in and out through its own edge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(fixture);
    const drawer = page.locator(`[data-edge-drawer="${side}"]`);
    const toggle = side === "left"
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

test("reversing the right drawer before it settles preserves its open content", async ({ page }) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(fixture);
  const toggle = page.getByTestId("side-pane-toggle");
  await toggle.evaluate(async (button) => {
    const click = () => (button as HTMLButtonElement).click();
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

test("the right drawer stays on its edge when the left sidebar moves the workspace across the overlay breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 850, height: 800 });
  await page.goto(fixture);
  const offsets = await page.getByTestId("side-pane-toggle").evaluate(async (button, leftToggleName) => {
    const left = document.querySelector<HTMLButtonElement>(
      `[data-edge-drawer="left"] button[aria-label="${leftToggleName}"]`,
    )!;
    const right = document.querySelector<HTMLElement>('[data-edge-drawer="right"]')!;
    left.click();
    (button as HTMLButtonElement).click();
    const offsets = [];
    for (let frame = 0; frame < 24; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      offsets.push(right.getBoundingClientRect().right - right.parentElement!.getBoundingClientRect().right);
    }
    return offsets;
  }, leftToggleName);
  expect(offsets.some((offset) => offset > 10)).toBe(true);
  expect(offsets.every((offset) => offset >= -1)).toBe(true);
  await expect(page.locator('[data-edge-drawer="right"]')).not.toHaveAttribute("data-edge-drawer-sliding");
});

test("both drawer surfaces settle immediately with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(fixture);
  for (const side of ["left", "right"] as const) {
    const drawer = page.locator(`[data-edge-drawer="${side}"]`);
    const toggle = side === "left"
      ? page.getByRole("button", { name: leftToggleName })
      : page.getByTestId("side-pane-toggle");
    await toggle.click();
    if (side === "left") await expect(drawer).toBeHidden();
    else await expect(drawer).toBeVisible();
    await expect(drawer).not.toHaveAttribute("data-edge-drawer-sliding");
    expect(await drawer.evaluate((el) => el.getAnimations().length)).toBe(0);
  }
});
