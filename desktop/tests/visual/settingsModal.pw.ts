import { expect, test } from "@playwright/test";
import { color } from "./contrast.ts";

test("Agent 切换进度浮在设置上并阻塞输入，退出后保留 Agent 页签", async ({
  page,
}) => {
  await page.goto("/tests/visual/fixture.html?agent-switch-modal");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const tab = settings.getByRole("tab", { name: "Agent", exact: true });
  await tab.click();
  const start = settings.getByRole("button", { name: "切换到 OpenCode" });
  const confirm = page.getByRole("dialog", {
    name: "切换 Agent 确认",
    exact: true,
  });
  await start.click();
  await confirm.getByRole("button", { name: "确认切换" }).click();

  const progress = page.getByRole("dialog", { name: "Agent 切换进度" });
  await expect(progress).toBeFocused();
  const closeSettings = await settings
    .getByRole("button", { name: "关闭设置" })
    .boundingBox();
  expect(closeSettings).not.toBeNull();
  await page.mouse.click(
    closeSettings!.x + closeSettings!.width / 2,
    closeSettings!.y + closeSettings!.height / 2,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(progress).toBeFocused();
  await expect(settings).toBeVisible();
  await expect(progress.getByRole("button", { name: "最小化" })).toHaveCount(0);

  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-agent-switch-result", { detail: "failed" }),
    ),
  );
  await expect(progress.getByRole("alert")).toHaveText(/测试连接失败/);
  await progress.getByRole("button", { name: "重试" }).click();
  const retry = page.getByRole("dialog", { name: "重试切换 Agent 确认" });
  await expect(retry.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(retry).toBeHidden();
  await progress.getByRole("button", { name: "退出" }).click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(start).toBeFocused();

  await start.press("Enter");
  await confirm.getByRole("button", { name: "确认切换" }).click();
  await expect(progress).toBeFocused();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("fixture-agent-switch-result")),
  );
  await expect(progress.getByText("切换成功", { exact: true })).toBeVisible();
  await expect(progress).toBeHidden();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(start).toBeFocused();
});

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
    await expect(card).toHaveCSS("box-shadow", "none");
    await expect(selected).toHaveCSS("box-shadow", /0px -2px 0px 0px inset/);
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

test("勾选存储范围时保持设置弹窗和内容滚动位置", async ({ page }) => {
  await page.setViewportSize({ width: 1034, height: 880 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/visual/fixture.html?storage-scroll");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("tab", { name: "存储", exact: true }).click();
  await dialog.getByRole("button", { name: "诊断日志", exact: true }).click();
  const legacy = dialog.getByRole("button", {
    name: "迁移遗留数据",
    exact: true,
  });
  await legacy.click();
  const details = dialog.locator(
    `[id="${await legacy.getAttribute("aria-controls")}"]`,
  );
  const checkbox = details.getByRole("checkbox", {
    name: "选择 应用数据 历史记录",
    exact: true,
  });
  const inputLabel = checkbox
    .locator("..")
    .getByText("应用数据", { exact: true });
  const help = dialog.getByRole("button", {
    name: "迁移遗留数据说明",
    exact: true,
  });
  await inputLabel.scrollIntoViewIfNeeded();
  await expect(help).toBeInViewport();
  const layout = () =>
    dialog.evaluate((panel) => {
      const content = panel
        .querySelector<HTMLElement>("#settings-panel-storage")!
        .closest<HTMLElement>(".overflow-auto")!;
      return {
        dialogScroll: panel.scrollTop,
        contentScroll: content.scrollTop,
        headerTop: panel.querySelector("header")!.getBoundingClientRect().top,
        statusTop: panel
          .querySelector('[role="status"]')!
          .getBoundingClientRect().top,
      };
    });
  const before = await layout();
  expect(before.dialogScroll).toBe(0);
  expect(before.contentScroll).toBeGreaterThan(0);

  await inputLabel.click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  expect(await layout()).toEqual(before);

  await help.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("spinbutton", { name: "迁移遗留数据提醒阈值（MiB）" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  expect(await layout()).toEqual(before);
});

for (const width of [1034, 710]) {
  test(`存储明细滚轮滚动设置内容（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 880 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/tests/visual/fixture.html?storage-scroll");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await dialog.getByRole("tab", { name: "存储", exact: true }).click();
    const logs = dialog.getByRole("button", { name: "诊断日志", exact: true });
    await logs.click();
    const content = dialog.locator("[class~='@container/settings']");
    const scrollTop = () => content.evaluate((element) => element.scrollTop);

    await logs.hover();
    const beforeRow = await scrollTop();
    await page.mouse.wheel(0, 360);
    await expect.poll(scrollTop).toBeGreaterThan(beforeRow);

    const threshold = dialog.getByRole("spinbutton", {
      name: "诊断日志提醒阈值（MiB）",
    });
    await threshold.hover();
    const beforeInput = await scrollTop();
    const value = await threshold.inputValue();
    await page.mouse.wheel(0, 360);
    await expect.poll(scrollTop).toBeGreaterThan(beforeInput);
    await expect(threshold).toHaveValue(value);
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);

    if (width === 710) {
      const table = dialog.locator(".overflow-x-auto").filter({
        hasText: "数据分类",
      });
      await logs.hover();
      await page.mouse.wheel(120, 0);
      await expect
        .poll(() => table.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
  });
}
