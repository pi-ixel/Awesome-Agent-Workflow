import { expect, test } from "@playwright/test";
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
  await left.evaluate((e) => { e.scrollLeft = e.scrollWidth; });
  await expect.poll(async () => (await left.evaluate((e) => e.scrollLeft)) - (await right.evaluate((e) => e.scrollLeft))).toBe(0);
  await expect(left.locator("span.sticky").first()).toHaveCSS("position", "sticky");
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
