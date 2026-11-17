import { expect, test, type Locator } from "@playwright/test";

const fixture = "/tests/visual/sessionStatusOverlayFixture.html?right-panel&workbench";
const leftToggleName = "展开/收起侧边栏";

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
