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

test("text 块保留缩进和复制原文，路径能用键盘打开到指定行", async ({
  page,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html?links");
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: (text: string) => {
        document.documentElement.dataset.copiedText = text;
        return Promise.resolve();
      },
    });
  });
  const block = page.locator('[data-language="text"]');
  const path = block.getByRole("button", { name: "README.md:12" });
  const original = "  README.md:12  \n说明文字";
  expect(await block.locator("pre code").textContent()).toBe(original);
  for (const theme of ["暖白", "暗夜"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await path.hover();
    await expect(path).toHaveCSS("text-decoration-line", "underline");
    await path.press("Enter");
    await expect(path).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute(
      "data-opened-file",
      "/project/README.md",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-opened-line",
      "12",
    );
  }
  await block.getByRole("button", { name: "复制代码" }).press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-text",
    original + "\n",
  );
});
