import { expect, test } from "@playwright/test";

test("session stats replace the instant rate and fit wide and narrow input bars", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/tests/visual/fixture.html?performance");
  const trigger = page.getByRole("button", { name: "会话统计", exact: true });
  await expect(trigger).toContainText("95.0 tok/s");
  await expect(trigger.locator("span")).toBeVisible();
  await trigger.hover();
  const card = page.getByRole("dialog", { name: "会话统计详情" });
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(card).toContainText("12 分 7 秒");
  await card.getByRole("button", { name: "模型用时说明" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("客户端观测");
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await page.setViewportSize({ width: 500, height: 720 });
  await expect(trigger.locator("span")).not.toBeVisible();
  await expect(trigger).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  const triggerBox = (await trigger.boundingBox())!;
  const sendBox = (await page
    .getByRole("button", { name: "发送", exact: true })
    .boundingBox())!;
  expect(triggerBox.x).toBeGreaterThan(0);
  expect(triggerBox.x + triggerBox.width).toBeLessThan(sendBox.x);
  expect(sendBox.x + sendBox.width).toBeLessThan(500);
  await trigger.click();
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(492);
});
