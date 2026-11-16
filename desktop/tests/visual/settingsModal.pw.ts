import { expect, test } from "@playwright/test";

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
        element.getAnimations().map((animation) => animation.finished),
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
    await expect(page.getByRole("heading", { name: "存储", exact: true })).toHaveClass("sr-only");
    await expect(page.getByRole("group", { name: "设置操作" })).toBeInViewport();
    await expect(dialog).toHaveClass(/shadow-md/);
    await expect(dialog).not.toHaveClass(/shadow-elev-3/);
    await page.screenshot({
      path: `node_modules/.cache/settings-modal-${width}.png`,
    });
  });
}
