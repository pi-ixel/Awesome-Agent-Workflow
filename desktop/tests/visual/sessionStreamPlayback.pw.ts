import { expect, test, type Page } from "@playwright/test";

function feed(page: Page, text: string) {
  return page.evaluate(
    (detail) =>
      window.dispatchEvent(new CustomEvent("fixture-stream-chunk", { detail })),
    text,
  );
}

test("上翻和隐藏时停止上屏，回到底部或恢复可见时直接追平", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(
    "/tests/visual/sessionStatusOverlayFixture.html?stream-playback",
  );
  const messages = page.getByRole("log", { name: "消息流" });
  await expect(messages.getByText("检查第 12 项")).toBeVisible();
  await feed(page, "已显示首段");
  await expect(messages).toContainText("已显示首段");

  await messages.hover({ position: { x: 100, y: 150 } });
  await page.mouse.wheel(0, -600);
  const bottom = page.getByRole("button", { name: "回到底部" });
  await expect(bottom).toBeVisible();
  await expect
    .poll(() =>
      messages.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeGreaterThan(400);
  const position = await messages.evaluate((node) => node.scrollTop);
  await feed(page, "阅读期间到达");
  // 等过一个完整追赶窗口，确认正文和阅读位置都没有被推动。
  await expect(messages).not.toContainText("阅读期间到达");
  await page.waitForTimeout(300);
  await expect(messages).not.toContainText("阅读期间到达");
  expect(await messages.evaluate((node) => node.scrollTop)).toBe(position);
  await bottom.click();
  await expect(messages).toContainText("已显示首段阅读期间到达");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await feed(page, "隐藏期间到达");
  await page.waitForTimeout(300);
  await expect(messages).not.toContainText("隐藏期间到达");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(messages).toContainText("已显示首段阅读期间到达隐藏期间到达");

  const setDisplayed = (displayed: boolean) =>
    page.evaluate((detail) => {
      window.dispatchEvent(
        new CustomEvent("fixture-window-displayed", { detail }),
      );
      return document.visibilityState;
    }, displayed);
  expect(await setDisplayed(false)).toBe("visible");
  await feed(page, "原生窗口最小化期间到达");
  await page.waitForTimeout(300);
  await expect(messages).not.toContainText("原生窗口最小化期间到达");
  await setDisplayed(true);
  await expect(messages).toContainText("隐藏期间到达原生窗口最小化期间到达");

  await expect
    .poll(() =>
      messages.evaluate((node) =>
        Math.abs(node.scrollHeight - node.scrollTop - node.clientHeight),
      ),
    )
    .toBeLessThanOrEqual(2);
});
