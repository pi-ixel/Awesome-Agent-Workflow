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
    await page.setViewportSize({ width: 680, height: 760 });
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
    const before = (await image.boundingBox())!;
    const anchorX = before.x + before.width * 0.62;
    await page.mouse.move(anchorX, before.y + before.height / 2);
    await page.mouse.wheel(0, -100);
    await expect(preview.getByText("102%", { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const next = (await image.boundingBox())!;
        return Math.abs(next.x + next.width * 0.62 - anchorX);
      })
      .toBeLessThan(1.5);
    await page.mouse.wheel(0, 100);
    await expect(preview.getByText("100%", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(thumbnail).toBeFocused();
  });
}

test("点击任何图片留白关闭预览，图上点击、缩放和拖出图片松手继续预览", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 670 });
  await page.goto("/tests/visual/fixture.html?image-attachments=draft");
  const thumbnail = page.getByRole("button", { name: "预览 screenshot.png" });
  const preview = page.getByRole("dialog", { name: "图片预览" });
  const image = preview.getByRole("img", { name: "screenshot.png" });
  const viewport = preview.locator("[data-image-preview-viewport]");
  await thumbnail.click();
  await expect(image).toHaveJSProperty("naturalWidth", 1200);
  await image.click();
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "放大" }).click();
  await expect(preview.getByText("150%", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "缩小" }).click();
  const picture = (await image.boundingBox())!;
  const canvas = (await viewport.boundingBox())!;
  const x = canvas.x + canvas.width / 2;
  const blankY = canvas.y + 8;
  expect(picture.y).toBeGreaterThan(blankY);
  await page.mouse.move(x, picture.y + picture.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, blankY, { steps: 8 });
  await page.mouse.up();
  await expect(preview).toBeVisible();
  await page.mouse.click(x, blankY);
  await expect(preview).toBeHidden();
  await expect(thumbnail).toBeFocused();

  await thumbnail.click();
  await preview.getByText("100%", { exact: true }).click();
  await expect(preview).toBeHidden();
  await thumbnail.click();
  await preview.click({ position: { x: 2, y: 2 } });
  await expect(preview).toBeHidden();
});

test("Markdown 画廊可滚轮缩放并保留翻页、下载和原来的缩放上限", async ({
  page,
}) => {
  await page.goto("/tests/visual/fixture.html?image-attachments=gallery");
  const thumbnail = page.getByRole("button", { name: "打开图片预览" }).first();
  await expect(thumbnail).toBeEnabled();
  await thumbnail.click();
  const preview = page.getByRole("dialog", { name: "图片预览" });
  const image = preview.getByRole("img", { name: "图一" });
  const zoom = preview.getByRole("button", { name: "放大" });
  for (let step = 0; step < 4; step++) await zoom.click();
  await expect(preview.getByText("300%", { exact: true })).toBeVisible();
  await image.hover();
  await page.mouse.wheel(0, -100);
  await expect(preview.getByText("300%", { exact: true })).toBeVisible();
  await page.mouse.wheel(0, 100);
  await expect(preview.getByText("294%", { exact: true })).toBeVisible();

  await preview.getByRole("button", { name: "下一张" }).click();
  await expect(preview.getByRole("img", { name: "图二" })).toBeVisible();
  await expect(preview.getByText("100%", { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await preview.getByRole("button", { name: "下载图片" }).click();
  await downloaded;
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "下一张" }).press("ArrowLeft");
  await expect(image).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(thumbnail).toBeFocused();
});
