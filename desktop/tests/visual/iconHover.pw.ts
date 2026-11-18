import { expect, test, type Locator } from "@playwright/test";

const fixture = "/tests/visual/iconHoverFixture.html";
const glyph = (button: Locator) => button.locator(":scope > .icon-hover-glyph");
async function offset(button: Locator) {
  return button.evaluate((el) => {
    const value = getComputedStyle(el.querySelector(".icon-hover-glyph")!)
      .translate.split(/\s+/)
      .map(Number.parseFloat);
    return { x: value[0] || 0, y: value[1] || 0 };
  });
}

for (const [placement, x, y] of [
  ["left", 2.5, 0],
  ["right", -2.5, 0],
  ["top", 0, -2.5],
  ["bottom", 0, -2.5],
] as const) {
  test(`${placement} 栏仅向布局规定的方向轻抬图标，按钮和邻居保持原位`, async ({
    page,
  }) => {
    await page.goto(fixture);
    const button = page.getByRole("button", {
      name: `${placement} 操作`,
      exact: true,
    });
    const buttonBox = await button.boundingBox();
    const neighbor = page.getByTestId(`${placement}-neighbor`);
    const neighborBox = await neighbor.boundingBox();
    await button.hover();
    await expect(glyph(button)).toHaveCSS("scale", "1.09");
    await expect.poll(() => offset(button)).toEqual({ x, y });
    await expect(glyph(button)).toHaveCSS(
      "transition-duration",
      "0.24s, 0.24s",
    );
    expect(await button.boundingBox()).toEqual(buttonBox);
    expect(await neighbor.boundingBox()).toEqual(neighborBox);
    await page.mouse.move(700, 700);
    await expect(glyph(button)).toHaveCSS("scale", "1");
    await expect.poll(() => offset(button)).toEqual({ x: 0, y: 0 });
  });
}

test("键盘焦点、ref 和点击保持原生按钮行为", async ({ page }) => {
  await page.goto(fixture);
  const button = page.getByRole("button", { name: "left 操作", exact: true });
  await page.getByRole("button", { name: "聚焦左栏" }).focus();
  await page.keyboard.press("Enter");
  await expect(button).toBeFocused();
  await expect.poll(() => offset(button)).toEqual({ x: 2.5, y: 0 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("点击次数")).toHaveText("2");
});

test("边缘悬停和快速反转不会闪烁、偏移点击区域或叠加位移", async ({ page }) => {
  await page.goto(fixture);
  const button = page.getByRole("button", { name: "left 操作", exact: true });
  const box = (await button.boundingBox())!;
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.move(700, 700);
  }
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await expect.poll(() => offset(button)).toEqual({ x: 2.5, y: 0 });
  await expect(glyph(button)).toHaveCSS("scale", "1.09");
  expect(await button.boundingBox()).toEqual(box);
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await expect(page.getByLabel("点击次数")).toHaveText("1");
});

test("布局位置变更时沿用同一图标节点，并支持局部覆盖", async ({ page }) => {
  await page.goto(fixture);
  const button = page.getByRole("button", { name: "动态栏操作" });
  await glyph(button).evaluate((node) =>
    node.setAttribute("data-original-node", "true"),
  );
  await button.hover();
  await expect.poll(() => offset(button)).toEqual({ x: 2.5, y: 0 });
  await page
    .getByRole("button", { name: "切换栏位置" })
    .evaluate((node) => (node as HTMLButtonElement).click());
  await expect.poll(() => offset(button)).toEqual({ x: -2.5, y: 0 });
  await expect(glyph(button)).toHaveAttribute("data-original-node", "true");
  const override = page.getByRole("button", { name: "覆盖栏方向" });
  await override.hover();
  await expect.poll(() => offset(override)).toEqual({ x: 0, y: -2.5 });
});

test("禁用状态和减少动画保持静止，旋转图标仍独立工作", async ({ page }) => {
  await page.goto(fixture);
  for (const label of ["禁用操作", "语义禁用操作"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.hover();
    await expect(glyph(button)).toHaveCSS("scale", "1");
    expect(await offset(button)).toEqual({ x: 0, y: 0 });
  }
  const spinning = page.getByRole("button", { name: "旋转图标" });
  await spinning.hover();
  await expect(glyph(spinning)).toHaveCSS("scale", "1.09");
  await expect(spinning.locator("svg")).toHaveCSS("animation-name", "spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(glyph(spinning)).toHaveCSS("scale", "1");
  await expect(glyph(spinning)).toHaveCSS("transition-duration", "0s");
  expect(await offset(spinning)).toEqual({ x: 0, y: 0 });
});

test("实际工作台的左竖栏向右，顶部右工具栏向上", async ({ page }) => {
  await page.setViewportSize({ width: 1480, height: 800 });
  await page.goto(
    "/tests/visual/sessionStatusOverlayFixture.html?right-panel&workbench&activity-rail",
  );
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const settings = rail.getByRole("button", { name: "设置", exact: true });
  const before = await settings.boundingBox();
  await settings.hover();
  await expect.poll(() => offset(settings)).toEqual({ x: 2.5, y: 0 });
  expect(await settings.boundingBox()).toEqual(before);
  const sidebarToggle = page.getByRole("button", { name: "展开/收起侧边栏" });
  await sidebarToggle.hover();
  await expect.poll(() => offset(sidebarToggle)).toEqual({ x: 0, y: -2.5 });
  await page.getByTestId("side-pane-toggle").click();
  const overview = page.getByTestId("tab-overview-trigger");
  await overview.hover();
  await expect.poll(() => offset(overview)).toEqual({ x: 0, y: -2.5 });
});

test("实际文件树标题栏开关在左右布局中都向上抬升", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  const toggle = page.getByRole("button", { name: "收起目录" });
  await toggle.hover();
  await expect.poll(() => offset(toggle)).toEqual({ x: 0, y: -2.5 });
  await page.getByRole("button", { name: "文件树设置" }).click();
  await page
    .getByRole("group", { name: "文件树位置" })
    .getByRole("button", { name: "左侧", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await toggle.hover();
  await expect.poll(() => offset(toggle)).toEqual({ x: 0, y: -2.5 });
});

for (const theme of ["warm", "dark"]) {
  test(`${theme} 状态卡两个操作统一底色、圆角和尺寸，并向上轻抬`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 950, height: 760 });
    await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
    await page.evaluate(
      (mode) =>
        document.documentElement.classList.toggle(
          "theme-warm",
          mode === "warm",
        ),
      theme,
    );
    await page.getByRole("button", { name: /^展开会话状态/ }).click();
    await expect(page.locator(".session-status-panel")).toHaveCSS(
      "opacity",
      "1",
    );
    const appearances = [];
    for (const name of ["状态卡显示选项", "收起会话状态"]) {
      const button = page.getByRole("button", { name, exact: true });
      const before = await button.boundingBox();
      await button.hover();
      await expect.poll(() => offset(button)).toEqual({ x: 0, y: -2.5 });
      await expect(glyph(button)).toHaveCSS("scale", "1.09");
      expect(await button.boundingBox()).toEqual(before);
      appearances.push(
        await button.evaluate((node) => {
          const css = getComputedStyle(node),
            box = node.getBoundingClientRect();
          return {
            background: css.backgroundColor,
            shadow: css.boxShadow,
            radius: css.borderRadius,
            width: box.width,
            height: box.height,
          };
        }),
      );
      await page.mouse.move(50, 500);
    }
    expect(appearances[0]).toEqual(appearances[1]);
    expect(appearances[0]!.shadow).toBe("none");
  });
}
