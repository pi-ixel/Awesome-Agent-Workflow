import { expect, test } from "@playwright/test";

test("嵌套展开控件仅旋转自身箭头，换肤与字号更新保留展开层级", async ({
  page,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html?disclosure");
  const outer = page.locator("summary").filter({ hasText: "更新记录" });
  const inner = page.locator("summary").filter({ hasText: "版本详情" });
  await outer.press("Enter");
  await expect(outer.locator("svg")).toHaveCSS("rotate", "90deg");
  await expect(inner.locator("svg")).toHaveCSS("rotate", "none");
  await page.keyboard.press("Tab");
  await expect(inner).toBeFocused();
  await expect(inner).not.toHaveCSS("box-shadow", "none");
  await inner.press("Space");
  const text = page.getByText("已安装版本的更新说明");
  for (const [theme, size] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    const font = page.getByRole("spinbutton", { name: "界面字号" });
    await font.fill(String(size));
    await font.press("Enter");
    await expect(text).toBeVisible();
    await expect(inner.locator("svg")).toHaveCSS("rotate", "90deg");
    await expect(inner.locator("svg")).toHaveCSS("width", size + "px");
  }
  await inner.press("Enter");
  await expect(text).toBeHidden();
  await expect(outer.locator("svg")).toHaveCSS("rotate", "90deg");
});
