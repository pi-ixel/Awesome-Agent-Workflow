import { expect, test } from "@playwright/test";

for (const { mode, context, buttonName, imageName } of [
  {
    mode: "draft",
    context: "输入框",
    buttonName: "预览 screenshot.png",
    imageName: "screenshot.png",
  },
  {
    mode: "user",
    context: "用户消息",
    buttonName: "预览消息图片 1",
    imageName: "消息图片",
  },
  {
    mode: "agent",
    context: "Agent 消息",
    buttonName: "预览消息图片 1",
    imageName: "消息图片",
  },
]) {
  test(`${context}里的大图保持 64 像素缩略图，点击可以打开大图`, async ({
    page,
  }) => {
    await page.goto(`/tests/visual/fixture.html?image-attachments=${mode}`);
    const thumbnail = page.getByRole("button", { name: buttonName });
    await expect(thumbnail.locator("img")).toHaveJSProperty(
      "naturalWidth",
      1200,
    );
    await expect(thumbnail).toHaveCSS("width", "64px");
    await expect(thumbnail).toHaveCSS("height", "64px");

    await thumbnail.click();
    const preview = page.getByRole("dialog", { name: "图片预览" });
    await expect(preview).toBeVisible();
    const image = preview.getByRole("img", { name: imageName });
    await expect(image).toHaveJSProperty("naturalWidth", 1200);
    expect((await image.boundingBox())?.width).toBeGreaterThan(64);
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(thumbnail).toBeFocused();
  });
}
