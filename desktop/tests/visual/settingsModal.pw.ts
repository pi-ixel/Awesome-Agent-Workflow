import { expect, test } from "@playwright/test";
import { color } from "./contrast.ts";

test("会话设置的呈现方式卡片随双主题和三档字号更新，保留选择及键盘焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 430, height: 760 });
  await session.emulateMedia({ reducedMotion: "reduce" });
  await session.goto("/tests/visual/fixture.html?session-settings");
  await session.getByRole("tab", { name: "会话与审批" }).click();
  const picker = session.getByRole("group", { name: "信息流呈现方式" });
  const initial = picker.getByRole("button", { pressed: true });
  const choice = picker.getByRole("button", { pressed: false });
  const label = (await choice.textContent())!.trim();
  await expect(initial).toHaveCount(1);
  await choice.press("Enter");
  const selected = picker.getByRole("button", { name: label });
  const card = selected.locator("..");
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(selected).toBeFocused();
    await expect(selected).toHaveCSS("font-size", `${px}px`);
    await expect(card).not.toHaveCSS("box-shadow", "none");
    expect(
      await selected.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  const next = picker.getByRole("button", { pressed: false });
  await next.click();
  await expect(selected).toHaveAttribute("aria-pressed", "false");
});

test("窄窗口的设置分组支持方向键跨组导航，焦点与选中背景跟随主题", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/fixture.html?settings-keyboard");
  const tabs = page.getByRole("tablist", { name: "设置页签" });
  const items = tabs.getByRole("tab");
  const first = items.first();
  const last = items.last();
  await expect(first).toHaveText("外观");
  await expect(tabs.getByRole("group", { name: "数据与统计" })).toContainText(
    "存储",
  );
  await first.press("Home");
  for (const warm of [true, false, true]) {
    await page.evaluate((isWarm) => {
      document.documentElement.classList.toggle("theme-warm", isWarm);
      document.documentElement.style.setProperty("--ui-font-size", "20px");
    }, warm);
    await first.press("ArrowUp");
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toHaveAttribute("tabindex", "0");
    await expect(first).toHaveAttribute("tabindex", "-1");
    await expect(last).toHaveCSS("font-size", "18px");
    await expect(last).not.toHaveCSS("box-shadow", "none");
    await expect
      .poll(() => color(last, "background-color"))
      .toEqual(await color(last, "--color-selected"));
    const id = await last.getAttribute("aria-controls");
    await expect(page.locator(`[id="${id}"]`)).toBeVisible();
    await last.press("ArrowDown");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-selected", "true");
  }
});

for (const width of [1400, 700, 390]) {
  test(`settings modal fits ${width}px and scrolls long content independently`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/tests/visual/fixture.html");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.evaluate(async (element) => {
      await Promise.all(
        (element.parentElement ?? element)
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    if (width === 390)
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
    await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(
      dialog.getByRole("heading", { name: "设置", exact: true }),
    ).toHaveCSS("color", "rgb(38, 38, 38)");
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(15);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 15);
    expect(bounds.y).toBeGreaterThanOrEqual(15);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(835);
    expect(
      await page.locator("#root").evaluate((el) => (el as HTMLElement).inert),
    ).toBe(true);
    const nav = page.getByRole("navigation", { name: "设置分组" });
    const before = await nav.boundingBox();
    await page
      .getByRole("region", { name: "模型用量" })
      .scrollIntoViewIfNeeded();
    expect(await nav.boundingBox()).toEqual(before);
    const close = page.getByRole("button", { name: "关闭设置" });
    await expect(close).toBeInViewport();
    await page.getByRole("tab", { name: "存储" }).click();
    await expect(page.getByRole("tabpanel", { name: "存储" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "存储", exact: true }),
    ).toHaveClass("sr-only");
    await expect(
      page.getByRole("group", { name: "设置操作" }),
    ).toBeInViewport();
    await expect(dialog).toHaveClass(/shadow-floating/);
    await expect(dialog).not.toHaveClass(/shadow-elev-3/);
    await page.screenshot({
      path: `node_modules/.cache/settings-modal-${width}.png`,
    });
  });
}

test("the settings backdrop and panel enter together", async ({ page }) => {
  await page.goto("/tests/visual/fixture.html");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  await page.addStyleTag({
    content:
      "[data-modal-layer], .modal-panel { animation-fill-mode: both !important; animation-play-state: paused !important; }",
  });
  const frames = await dialog.evaluate((panel) => {
    const layer = panel.parentElement!;
    const [fade] = layer.getAnimations();
    const [move] = panel.getAnimations();
    if (!fade || !move) throw new Error("缺少弹窗入场动画");
    return [0, 32, 220].map((time) => {
      fade.currentTime = time;
      move.currentTime = time;
      const panelStyle = getComputedStyle(panel);
      const transform = new DOMMatrix(panelStyle.transform);
      return {
        opacity: Number(getComputedStyle(layer).opacity),
        panelOpacity: Number(panelStyle.opacity),
        offset: transform.f,
        scale: transform.a,
      };
    });
  });
  expect(frames[0]).toEqual({
    opacity: 0,
    panelOpacity: 1,
    offset: 6,
    scale: 0.99,
  });
  const middle = frames[1]!;
  expect(middle.opacity).toBeGreaterThan(0);
  expect(middle.opacity).toBeLessThan(1);
  expect(middle.panelOpacity).toBe(1);
  expect(middle.offset).toBeGreaterThan(0);
  expect(middle.offset).toBeLessThan(6);
  expect(frames[2]).toEqual({
    opacity: 1,
    panelOpacity: 1,
    offset: 0,
    scale: 1,
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dialog).toHaveCSS("transform", "none");
  const layer = page.locator('[data-modal-layer="settings"]');
  await expect(layer).toHaveCSS("animation-name", "none");
  await expect(layer).toHaveCSS("opacity", "1");
});
