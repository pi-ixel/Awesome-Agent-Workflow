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
  const split = comparison.getByLabel("Git 左右差异").first();
  await split.getByRole("button", { name: "换行", exact: true }).click();
  const find = comparison.getByRole("button", { name: "查找末尾" });
  await find.press("Enter");
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
  await views
    .first()
    .getByRole("button", { name: "换行", exact: true })
    .click();
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

test("Git Changes 默认折叠超长行的显示宽度并保持双栏逐行对齐", async ({
  page,
}) => {
  await page.setViewportSize({ width: 540, height: 1000 });
  await page.goto("/tests/visual/gitScrollFixture.html");
  const split = page.getByLabel("Git 左右差异").first();
  await expect(
    split.getByRole("button", { name: "换行", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const before = split.getByLabel("修改前");
  const after = split.getByLabel("修改后");
  const rows = async () => {
    const positions = (side: typeof before) =>
      side.locator("code").evaluateAll((cells) =>
        cells.map((cell) => ({
          top: cell.parentElement!.getBoundingClientRect().top,
          height: cell.parentElement!.getBoundingClientRect().height,
        })),
      );
    return [await positions(before), await positions(after)];
  };
  for (const width of [540, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(before.locator("code").first()).toHaveCSS(
      "white-space",
      "pre-wrap",
    );
    const [left, right] = await rows();
    expect(left).toEqual(right);
    expect(left?.[0]?.height).toBeGreaterThan((left?.[1]?.height ?? 0) * 2);
    for (const side of [before, after]) {
      expect(
        await side.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBe(0);
    }
  }
});
