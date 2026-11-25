import { expect, test } from "@playwright/test";

test("消息正文的文件引用与外链共用键盘焦点和悬停样式，并打开各自的目标", async ({ page }) => {
  await page.goto("/tests/visual/uiScaleFixture.html?links");
  const file = page.getByRole("button", { name: "项目说明" });
  const absolute = page.getByRole("button", { name: "sample.html", exact: true });
  const link = page.getByRole("button", { name: "外部文档" });
  await expect(absolute.locator("svg")).toBeVisible();
  await expect(absolute).toHaveAttribute("data-hint", "D:/outside/sample.html");
  for (const theme of ["暖白", "暗夜"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    for (const button of [file, link]) {
      await button.hover();
      await expect(button).toHaveCSS("text-decoration-line", "underline");
      await button.press("Enter");
      await expect(button).toBeFocused();
      await expect(button).not.toHaveCSS("box-shadow", "none");
    }
    await expect(page.locator("html")).toHaveAttribute("data-opened-file", "/project/README.md");
    await expect(page.locator("html")).toHaveAttribute("data-opened-url", "https://example.org/guide");
    const linkColor = await file.evaluate((node) => getComputedStyle(node).color);
    await expect(absolute.locator("code")).toHaveCSS("color", linkColor);
    await absolute.hover();
    await expect(absolute).toHaveCSS("text-decoration-line", "underline");
    await absolute.press("Enter");
    await expect(absolute).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-opened-file", "D:/outside/sample.html");
  }
});
