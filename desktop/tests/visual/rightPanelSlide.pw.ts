import { expect, test, type Locator } from "@playwright/test";

async function sampleSlide(trigger: Locator) {
  return trigger.evaluate(async (button) => {
    const log = document.querySelector<HTMLElement>("[data-session-messages]")!;
    const panel = document.querySelector<HTMLElement>('aside[aria-label="项目右侧工具栏"]')!;
    const frame = () => ({
      chatWidth: log.clientWidth,
      panelWidth: panel.offsetWidth,
      panelLeft: Math.round(panel.getBoundingClientRect().left),
      bottomGap: log.scrollHeight - log.clientHeight - log.scrollTop,
      gutter: log.offsetWidth - log.clientWidth,
      thumb: getComputedStyle(log, "::-webkit-scrollbar-thumb").backgroundColor,
      sliding: !!panel.closest("[data-panel-slide]"),
    });
    const before = frame();
    if (!(button instanceof HTMLElement)) throw new Error("Expected a button");
    button.click();
    const frames = [];
    for (let i = 0; i < 32; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(frame());
    }
    return { before, frames, after: frame() };
  });
}

test("file panel slides at fixed width and chat stays pinned to its latest message", async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 800 });
  await page.goto("/tests/visual/sessionStatusOverlayFixture.html?right-panel");
  const toggle = page.getByTestId("side-pane-toggle");
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("保留草稿");
  for (const trigger of [toggle, page.getByRole("button", { name: "关闭右栏", exact: true })]) {
    const { before, frames, after } = await sampleSlide(trigger);
    const moving = frames.filter((frame) => frame.sliding);
    expect(new Set(moving.map((frame) => frame.panelLeft)).size).toBeGreaterThan(2);
    expect(new Set(moving.map((frame) => frame.panelWidth)).size).toBe(1);
    expect(moving.every((frame) => frame.chatWidth === before.chatWidth)).toBe(true);
    expect(new Set(frames.map((frame) => frame.chatWidth)).size).toBe(2);
    expect(Math.abs(after.chatWidth - before.chatWidth)).toBeGreaterThan(500);
    expect(frames.every((frame) => Math.abs(frame.bottomGap) <= 2 && frame.gutter === before.gutter)).toBe(true);
    if (before.panelWidth > 0) {
      expect(moving.some((frame) => frame.thumb !== before.thumb)).toBe(true);
      expect(after.thumb).toBe(before.thumb);
    }
  }
  await expect(input).toHaveValue("保留草稿");
});

for (const motion of ["no-preference", "reduce"] as const) {
  test(`right panel keeps the visible message when reading history (${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await page.setViewportSize({ width: 1560, height: 800 });
    await page.goto("/tests/visual/sessionStatusOverlayFixture.html?right-panel");
    const toggle = page.getByTestId("side-pane-toggle");
    await toggle.click();
    await expect(page.locator("[data-panel-slide]")).toHaveCount(0);
    const log = page.getByRole("log", { name: "消息流" });
    await log.hover({ position: { x: 100, y: 150 } });
    await page.mouse.wheel(0, -600);
    await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();
    const previous = await log.evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      const items = Array.from(node.querySelectorAll<HTMLElement>('[data-item-kind="user"]'));
      const item = items.find((entry) => entry.getBoundingClientRect().top > top + 10)!;
      node.scrollTop += item.getBoundingClientRect().top - top + 8;
      return { id: item.dataset.itemId, y: item.getBoundingClientRect().top };
    });
    await page.keyboard.press("Escape");
    await expect(page.locator('aside[aria-label="项目右侧工具栏"]')).toBeHidden();
    await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();
    const item = log.locator(`[data-item-id="${previous.id}"]`);
    expect(Math.abs((await item.boundingBox())!.y - previous.y)).toBeLessThan(2);
  });
}
