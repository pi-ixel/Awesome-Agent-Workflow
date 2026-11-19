import { expect, test } from "@playwright/test";

for (const width of [1550, 950]) {
  test(`session status overlays the full-width chat without moving it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
    const messages = page.getByRole("log", { name: "消息流" });
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await expect(input).toBeVisible();
    await input.fill("输入区草稿");
    await messages.hover({ position: { x: 120, y: 150 } });
    await page.mouse.wheel(0, -550);
    await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();

    const layout = () => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>("[data-session-messages]")!;
      const message = scroll.querySelector<HTMLElement>('[data-item-kind="assistant"]')!;
      const composer = document.querySelector<HTMLElement>(".composer-card")!;
      const box = (element: HTMLElement) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { message: box(message), composer: box(composer), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    });
    const original = await layout();
    const capsule = page.getByRole("button", { name: /^展开会话状态/ });
    const collapse = page.getByRole("button", { name: "收起会话状态" });
    const panel = page.locator(".session-status-panel");

    await capsule.click();
    expect(await layout()).toEqual(original);
    await expect(panel).toHaveCSS("opacity", "1");
    expect(await layout()).toEqual(original);
    await input.click();
    await expect(input).toHaveValue("输入区草稿");
    await expect(panel).toBeVisible();
    expect(await layout()).toEqual(original);

    await collapse.click();
    expect(await layout()).toEqual(original);
    await expect(panel).toBeHidden();
    expect(await layout()).toEqual(original);

    await capsule.click();
    await page.getByRole("button", { name: "状态卡显示选项" }).click();
    await page.getByRole("button", { name: "恢复自动展开" }).click();
    if (width >= 1280) await expect(panel).toHaveCSS("opacity", "1");
    else await expect(panel).toBeHidden();
    expect(await layout()).toEqual(original);
  });
}

test("session status sections animate through the shared tree branch", async ({ page }) => {
  await page.setViewportSize({ width: 950, height: 760 });
  await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
  await page.getByRole("button", { name: /^展开会话状态/ }).click();
  const toggle = page.getByRole("button", { name: "Git 工具" });
  const heights = await toggle.evaluate(async (button) => {
    const branch = document.getElementById(button.getAttribute("aria-controls")!)!;
    const height = () => branch.getBoundingClientRect().height;
    const openHeight = height();
    (button as HTMLButtonElement).click();
    const samples = [];
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(height());
    }
    return { openHeight, samples };
  });
  expect(heights.samples.some((height) => height > 0 && height < heights.openHeight)).toBe(true);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(heights.samples.at(-1)).toBe(0);
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("正在读取 Git 状态…")).toBeVisible();
});
