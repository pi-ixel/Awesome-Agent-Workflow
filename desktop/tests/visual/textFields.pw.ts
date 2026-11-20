import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

for (const theme of ["暖白", "暗夜"]) {
  test(
    theme + " 下五种编辑样式跟随字号，支持键盘输入并显示错误状态",
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 680 });
      await page.goto("/tests/visual/uiScaleFixture.html?fields");
      await page.getByRole("button", { name: theme, exact: true }).click();
      const section = page.getByRole("region", { name: "编辑输入" });
      const font = page.getByRole("spinbutton", { name: "界面字号" });
      for (const size of [12, 14, 20]) {
        await font.fill(String(size));
        await font.press("Enter");
        for (const label of [
          "普通文本",
          "数值",
          "多行文本",
          "内嵌查找",
          "行内标题",
        ]) {
          const field = section.getByLabel(label);
          await expect(field).toHaveCSS("font-size", size + "px");
          await page.mouse.move(0, 0);
          const surface = await field.evaluate(
            (el) => getComputedStyle(el).backgroundColor,
          );
          await field.hover();
          await expect(field).toHaveCSS("background-color", surface);
          await field.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(field).toBeFocused();
          await expect(field).not.toHaveCSS("box-shadow", "none");
          const container = await color(section, "background-color");
          const bg = blend(await color(field, "background-color"), container);
          expect(
            ratio(blend(await color(field, "color"), bg), bg),
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            ratio(await color(field, "--color-focus-ring"), container),
          ).toBeGreaterThanOrEqual(3);
          await field.fill(String(size));
          await expect(field).toHaveValue(String(size));
        }
        for (const label of ["禁用值", "禁用阈值"]) {
          const disabled = section.getByLabel(label);
          await expect(disabled).toBeDisabled();
          expect(
            Number(
              await disabled.evaluate((el) => getComputedStyle(el).opacity),
            ),
          ).toBeLessThan(1);
        }
        for (const label of ["只读值", "正在保存标题"]) {
          const readOnly = section.getByLabel(label);
          await expect(readOnly).not.toBeEditable();
          await expect(readOnly).toBeEnabled();
          await readOnly.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(readOnly).toBeFocused();
        }
        const invalid = section.getByLabel("重命名错误");
        expect(await color(invalid, "border-top-color")).toEqual(
          await color(invalid, "--color-danger-ink"),
        );
        await expect(section.getByLabel("多行文本")).toHaveCSS(
          "resize",
          "vertical",
        );
        expect(
          await section.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      }
    },
  );
}
