import { expect, test, type Locator } from "@playwright/test";

async function checkIconSize(icon: Locator, size: number) {
  await expect(icon).toBeVisible();
  const { width, height } = (await icon.boundingBox())!;
  expect(width).toBeCloseTo(size, 1);
  expect(height).toBeCloseTo(size, 1);
}

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
  const checkSquare = page.getByTestId("checkbox").locator(":scope > span");

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
