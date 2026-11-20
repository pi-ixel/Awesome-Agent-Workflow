import { expect, test, type Locator } from "@playwright/test";

test("关于信息和紧凑日期行在最大字号下随容器换行并保留键盘焦点", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto("/tests/visual/uiScaleFixture.html?setting-rows");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await font.fill("20");
  await font.press("Enter");
  const key = page.getByText("构建版本", { exact: true });
  const value = page.getByText("0123456789abcdef".repeat(5));
  const dateLabel = page.getByText("日期", { exact: true });
  const date = page.getByLabel("日期", { exact: true });
  expect((await value.boundingBox())!.x).toBeGreaterThan((await key.boundingBox())!.x);
  expect((await date.boundingBox())!.x).toBeGreaterThan((await dateLabel.boundingBox())!.x);
  await dateLabel.click();
  await expect(date).toBeFocused();
  await page.setViewportSize({ width: 264, height: 800 });
  await expect(date).toBeFocused();
  for (const [label, field] of [[key, value], [dateLabel, date]] as const) {
    const top = (await label.boundingBox())!;
    const bottom = (await field.boundingBox())!;
    expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
    expect(bottom.x + bottom.width).toBeLessThanOrEqual(264);
  }
});

async function checkIconSize(icon: Locator, size: number) {
  await expect(icon).toBeVisible();
  const { width, height } = (await icon.boundingBox())!;
  expect(width).toBeCloseTo(size, 1);
  expect(height).toBeCloseTo(size, 1);
}

test("启动标志跟随两种主题和三档界面字号", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const splash = await context.newPage();
  await splash.emulateMedia({ reducedMotion: "reduce" });
  await splash.setViewportSize({ width: 420, height: 680 });
  await splash.goto("/tests/visual/uiScaleFixture.html?brand-mark&secondary");
  const brand = splash.getByRole("status").filter({ hasText: "正在打开工作区" });
  const mark = brand.locator("img");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(splash.locator("html")).toHaveCSS("--ui-font-size", `${px}px`);
    await checkIconSize(mark, (120 * px) / 14);
    await expect(mark).toHaveJSProperty("complete", true);
    await expect(brand.locator(".startup-pen").first()).toBeHidden();
  }
});

test("先打开和后打开的副窗口都随主窗口往返切换主题", async ({ page, context }) => {
  const early = await context.newPage();
  await early.goto("/tests/visual/uiScaleFixture.html?secondary");
  await page.goto("/tests/visual/uiScaleFixture.html");
  await page.getByRole("button", { name: "暖白", exact: true }).click();
  await expect(early.locator("html")).toHaveClass(/theme-warm/);
  const late = await context.newPage();
  await late.goto("/tests/visual/uiScaleFixture.html?secondary");
  await expect(late.locator("html")).toHaveClass(/theme-warm/);
  for (const name of ["暗夜", "暖白"]) {
    await page.getByRole("button", { name, exact: true }).click();
    for (const secondary of [early, late]) {
      if (name === "暗夜") await expect(secondary.locator("html")).not.toHaveClass(/theme-warm/);
      else await expect(secondary.locator("html")).toHaveClass(/theme-warm/);
    }
  }
});

async function checkFits(control: Locator, content: Locator) {
  const bounds = (await control.boundingBox())!;
  const inner = (await content.boundingBox())!;
  expect(inner.x).toBeGreaterThanOrEqual(bounds.x - 0.1);
  expect(inner.y).toBeGreaterThanOrEqual(bounds.y - 0.1);
  expect(inner.x + inner.width).toBeLessThanOrEqual(
    bounds.x + bounds.width + 0.1,
  );
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    bounds.y + bounds.height + 0.1,
  );
}

test("整数设置框在暖白和暗夜之间切换时使用当前主题的表面与文字颜色", async ({ page }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const input = page.getByRole("spinbutton", { name: "界面字号" });
  const checkmark = page.getByTestId("checkbox").locator("svg");
  const colors = () => input.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.color, style.borderTopColor];
  });
  await page.getByRole("button", { name: "暖白", exact: true }).click();
  const warm = await colors();
  const warmMark = await checkmark.evaluate((svg) => getComputedStyle(svg).color);
  await page.getByRole("button", { name: "暗夜", exact: true }).click();
  const dark = await colors();
  await expect(checkmark).not.toHaveCSS("color", warmMark);
  expect(dark[0]).not.toBe(warm[0]);
  expect(dark[1]).not.toBe(warm[1]);
  expect(dark[2]).not.toBe(warm[2]);
  await page.getByRole("button", { name: "暖白", exact: true }).click();
  expect(await colors()).toEqual(warm);
  await expect(checkmark).toHaveCSS("color", warmMark);
});

test("the interface font setting scales text and glyphs live without clipping controls", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  const refresh = page.getByRole("button", { name: "刷新文件", exact: true });
  const treeRow = page.getByRole("treeitem");
  const filename = treeRow.getByText("sample.ts");
  const emptyState = page.getByRole("status").filter({ hasText: "暂无文件" });
  const checkSquare = page.getByTestId("checkbox").locator("label > [aria-hidden]");

  await expect(font).toHaveValue("14");
  const secondary = await context.newPage();
  await secondary.goto("/tests/visual/uiScaleFixture.html?secondary");
  const secondaryRow = secondary.getByRole("treeitem");
  for (const size of [12, 14, 20]) {
    await font.fill(String(size));
    await font.press("Enter");
    await expect(filename).toHaveCSS("font-size", `${size}px`);
    await expect(secondaryRow).toHaveCSS("font-size", `${size}px`);
    await expect(page.locator("html")).toHaveCSS("font-size", "16px");

    const factor = size / 14;
    await checkIconSize(refresh.locator("svg"), 16 * factor);
    await checkIconSize(treeRow.locator("svg"), 16 * factor);
    await checkIconSize(secondaryRow.locator("svg"), 16 * factor);
    await checkIconSize(emptyState.locator("svg"), 24 * factor);
    await checkIconSize(checkSquare.locator("svg"), 12 * factor);

    await checkFits(refresh, refresh.locator("svg"));
    expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(20);
    await checkFits(treeRow, treeRow.locator("svg"));
    await checkFits(treeRow, filename);
    await checkFits(checkSquare, checkSquare.locator("svg"));
  }
});
