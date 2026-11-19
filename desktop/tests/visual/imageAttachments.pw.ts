import { expect, test } from "@playwright/test";

test("输入框里的大图保持 64 像素缩略图，点击可以打开大图", async ({ page }) => {
  await page.goto("/tests/visual/fixture.html?image-attachments");
  const thumbnail = page.getByRole("button", { name: "预览 screenshot.svg" });
  await expect(thumbnail.locator("img")).toHaveJSProperty("naturalWidth", 1200);
  await expect(thumbnail).toHaveCSS("width", "64px");
  await expect(thumbnail).toHaveCSS("height", "64px");

  await thumbnail.click();
  const preview = page.getByRole("dialog", { name: "图片预览" });
  await expect(preview).toBeVisible();
  const image = preview.getByRole("img", { name: "screenshot.svg" });
  await expect(image).toHaveJSProperty("naturalWidth", 1200);
  expect((await image.boundingBox())?.width).toBeGreaterThan(64);
});
