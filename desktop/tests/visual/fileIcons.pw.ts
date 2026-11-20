import { expect, test } from "@playwright/test";
import { ratio, parse } from "./contrast.ts";
import { ICON_VARIANTS } from "../../src/shared/ui/file-icons/fileDisplayHelpers.ts";

test("全部文件类型的描边随主题和字号更新，在三种文件行表面均可辨认", async ({ page }) => {
  await page.goto("/tests/visual/uiScaleFixture.html?file-icons");
  const section = page.getByRole("region", { name: "文件图标" });
  const glyphs = section.locator("svg");
  await expect(glyphs).toHaveCount(Object.keys(ICON_VARIANTS).length);
  for (const theme of ["暖白", "暗夜", "暖白"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    const surfaces = await section.evaluate(el => {
      const colors = ["--color-base", "--color-surface", "--color-raised"];
      return colors.map(token => {
        el.style.backgroundColor = "var(" + token + ")";
        return getComputedStyle(el).backgroundColor;
      });
    });
    const strokes = await glyphs.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).stroke));
    for (const stroke of strokes)
      for (const surface of surfaces)
        expect(ratio(parse(stroke), parse(surface)), theme + " " + stroke + " / " + surface).toBeGreaterThanOrEqual(3);
    for (const size of [12, 14, 20]) {
      const font = page.getByRole("spinbutton", { name: "界面字号" });
      await font.fill(String(size));
      await font.press("Enter");
      const sizes = await glyphs.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
      for (const width of sizes) expect(width).toBeCloseTo(16 * size / 14, 1);
    }
  }
});
