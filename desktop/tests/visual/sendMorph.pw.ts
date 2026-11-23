import { expect, test } from "@playwright/test";
import { color, ratio } from "./contrast.ts";

const fixture = "/tests/visual/sessionStatusOverlayFixture.html?send-morph";
const text = "把发送动效做得更连贯一些。";

test("点击发送从按钮原位置变形到实际落笔的消息气泡", async ({ page }) => {
  await page.goto(fixture);
  await page
    .locator("html")
    .evaluate((element) => element.classList.add("theme-warm"));
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill(text);
  const button = page.getByRole("button", { name: "发送", exact: true });
  const layer = page.locator("[data-send-morph-layer]");
  const message = page.locator("[data-user-message-bubble]").getByText(text);
  const time = Date.now();
  await page.clock.install({ time: new Date(time) });
  await page.clock.pauseAt(new Date(time + 1000));
  const start = await button.boundingBox();
  await button.evaluate((element) => {
    if (element instanceof HTMLButtonElement) element.click();
  });
  await expect(layer).toBeVisible();
  await expect(message).toHaveText(text);
  await expect(input).toHaveValue("");
  const shape = layer.locator(":scope > div");
  expect(await shape.boundingBox()).toEqual(start);
  await expect(shape).toHaveCSS("background-color", "rgb(59, 82, 110)");

  await page.clock.runFor(155);
  const rising = (await shape.boundingBox())!;
  expect(rising.y).toBeLessThan(start!.y);
  expect(rising.width).toBeCloseTo(start!.width);
  expect(rising.height).toBeGreaterThan(start!.height);

  await page.clock.runFor(175);
  const position = (await shape.boundingBox())!;
  expect(position.x).toBeLessThan(rising.x);
  expect(position.width).toBeGreaterThan(start!.width);
  await expect(shape).toHaveCSS("background-image", /^linear-gradient\(270deg/);
  await page.clock.runFor(400);
  await expect(layer).toBeHidden();
  await expect(page.locator("[data-user-message-bubble]")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(message).toBeVisible();
});

test("拒绝发送和减少动态效果时不会出现飞行动效", async ({ page }) => {
  await page.goto(fixture);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const button = page.getByRole("button", { name: "发送", exact: true });
  const layer = page.locator("[data-send-morph-layer]");
  await input.fill("拒绝这条消息");
  await button.click();
  await expect(input).toHaveValue("拒绝这条消息");
  await expect(layer).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await input.fill(text);
  await button.click();
  await expect(page.locator("[data-user-message-bubble]")).toHaveText(text);
  await expect(page.locator("[data-user-message-bubble]")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(layer).toBeHidden();
});

test("按 Enter 发送与点击使用同一按钮作为飞行起点", async ({ page }) => {
  await page.goto(fixture);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator("[data-send-morph-layer]")).toBeVisible();
  await expect(page.locator("[data-user-message-bubble]")).toHaveText(text);
});

test("气泡晚于发送落笔上屏时仍会播放飞行动效", async ({ page }) => {
  await page.goto(fixture + "&delay-bubble");
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const layer = page.locator("[data-send-morph-layer]");
  await input.fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(layer).toBeVisible();
  await expect(page.locator("[data-user-message-bubble]")).toHaveText(text);
  await expect(layer).toBeHidden();
});

test("暗夜主题提亮起飞按钮和气泡，并保留足够的文字对比度", async ({ page }) => {
  await page.goto(fixture);
  await page
    .locator("html")
    .evaluate((element) => element.classList.remove("theme-warm"));
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const button = page.getByRole("button", { name: "发送", exact: true });
  await input.fill(text);
  await expect(button).toHaveCSS("background-color", "rgb(138, 173, 210)");
  expect(
    ratio(
      await color(button, "color"),
      await color(button, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(4.5);
  await button.click();
  const bubble = page.locator("[data-user-message-bubble]");
  await expect(bubble).toHaveCSS("opacity", "1");
  await expect(bubble).toHaveCSS("background-color", "rgb(64, 94, 123)");
  const surface = await color(bubble, "background-color");
  expect(ratio(await color(bubble, "color"), surface)).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(
    ratio(surface, await color(bubble, "--color-base")),
  ).toBeGreaterThanOrEqual(2.4);
});
