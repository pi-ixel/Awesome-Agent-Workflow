import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

test("Git 分屏与统一差异共用颜色，换肤后保留查找命中和行号可读性", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 420, height: 780 });
  await page.goto("/tests/visual/uiScaleFixture.html?git-unified");
  const comparison = await context.newPage();
  await comparison.setViewportSize({ width: 420, height: 720 });
  await comparison.goto("/tests/visual/gitScrollFixture.html?appearance");
  const find = comparison.getByRole("button", { name: "查找末尾" });
  await find.press("Enter");
  const split = comparison.getByLabel("Git 左右差异").first();
  const older = split.getByLabel("修改前");
  const newer = split.getByLabel("修改后");
  const offset = () => older.evaluate((el) => el.scrollLeft);
  await expect.poll(offset).toBeGreaterThan(500);
  const current = older.locator("mark[data-current-hit]");
  await expect(current).toHaveText("SEARCHTARGET");
  const initialScroll = await offset();
  await page.getByRole("button", { name: "暖白", exact: true }).click();
  await expect(comparison.locator("html")).toHaveClass(/theme-warm/);
  await expect.poll(offset).toBe(initialScroll);
  await expect(find).toBeFocused();

  const unified = page.getByLabel("Git 统一差异");
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [warm, px] of [
    [true, 12],
    [false, 20],
    [true, 14],
  ] as const) {
    await page
      .getByRole("button", { name: warm ? "暖白" : "暗夜", exact: true })
      .click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(split).toHaveCSS("font-size", `${px - 2}px`);
    await expect(unified.locator("code").first()).toHaveCSS(
      "font-size",
      `${px - 2}px`,
    );
    await expect(current).toHaveText("SEARCHTARGET");
    await expect(find).toBeFocused();
    await expect
      .poll(
        async () =>
          (await offset()) - (await newer.evaluate((el) => el.scrollLeft)),
      )
      .toBe(0);
    for (const [side, line] of [
      [older, "-old"],
      [newer, "+new"],
    ] as const) {
      const row = unified.getByText(line, { exact: true }).locator("..");
      const splitRow = side.locator("code").first().locator("..");
      const splitNumber = splitRow.locator("span.sticky");
      const number = row.locator("span").filter({ hasText: /^1$/ });
      const base = await color(unified, "--color-base");
      const background = blend(await color(row, "background-color"), base);
      expect(await color(row, "background-color")).toEqual(
        await color(splitRow, "background-color"),
      );
      expect(await color(number, "color")).toEqual(
        await color(splitNumber, "color"),
      );
      expect(
        ratio(await color(number, "color"), background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        ratio(
          await color(splitNumber, "color"),
          await color(splitNumber, "background-color"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        ratio(await color(row.locator("code"), "color"), background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("both diff columns follow equal pixel positions despite uneven content and resize", async ({
  page,
}) => {
  await page.goto("/tests/visual/gitScrollFixture.html");
  const views = page.getByLabel("Git 左右差异");
  const left = views.nth(0).getByLabel("修改前"),
    right = views.nth(0).getByLabel("修改后");
  await expect
    .poll(() => right.evaluate((e) => e.scrollWidth - e.clientWidth))
    .toBeGreaterThan(500);
  await left.evaluate((e) => {
    e.scrollLeft = 350;
  });
  await expect.poll(() => right.evaluate((e) => e.scrollLeft)).toBe(350);
  const end = await left.evaluate((e) => {
    e.scrollLeft = e.scrollWidth;
    return e.scrollWidth - e.clientWidth;
  });
  await expect.poll(() => left.evaluate((e) => e.scrollLeft)).toBe(end);
  await expect.poll(() => right.evaluate((e) => e.scrollLeft)).toBe(end);
  await expect(left.locator("span.sticky").first()).toHaveCSS(
    "position",
    "sticky",
  );
  await right.evaluate((e) => {
    e.scrollLeft = 125;
  });
  await expect.poll(() => left.evaluate((e) => e.scrollLeft)).toBe(125);
  expect(
    await views
      .nth(1)
      .getByLabel("修改前")
      .evaluate((e) => e.scrollLeft),
  ).toBe(0);
  await page.setViewportSize({ width: 450, height: 700 });
  await expect.poll(() => right.evaluate((e) => e.scrollLeft)).toBe(125);
  await page.getByRole("button", { name: "查找末尾" }).click();
  await expect
    .poll(() => left.evaluate((e) => e.scrollLeft))
    .toBeGreaterThan(125);
  await expect
    .poll(() => right.evaluate((e) => e.scrollLeft))
    .toBe(await left.evaluate((e) => e.scrollLeft));
});
