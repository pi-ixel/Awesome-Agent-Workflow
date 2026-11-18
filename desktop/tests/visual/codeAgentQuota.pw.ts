import { expect, test } from "@playwright/test";

for (const theme of ["warm", "dark"]) {
  for (const width of [390, 955]) {
    test(`${theme} ${width}px：额度图标对齐、双页签排版、模型切换与分层 Escape`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 705 });
      await page.goto(
        `/tests/visual/codeAgentQuotaFixture.html?theme=${theme}`,
      );
      const trigger = page.getByRole("button", {
        name: "CodeAgent 额度",
        exact: true,
      });
      const panel = page.locator(
        '[popover="auto"][aria-label="CodeAgent 额度"]',
      );
      for (const size of [12, 14, 20]) {
        await page.evaluate(
          (size) =>
            document.documentElement.style.setProperty(
              "--ui-font-size",
              `${size}px`,
            ),
          size,
        );
        const icon = (await trigger.locator("svg").boundingBox())!;
        const settings = (await page
          .getByRole("button", { name: "设置", exact: true })
          .locator("svg")
          .boundingBox())!;
        expect(icon.width).toBeCloseTo(settings.width, 2);
        expect(icon.x + icon.width / 2).toBeCloseTo(
          settings.x + settings.width / 2,
          2,
        );
        await trigger.click();
        await expect(
          panel.getByRole("progressbar", { name: "月度已用 Credit" }),
        ).toHaveAttribute("aria-valuenow", "42");
        const card = (await panel.boundingBox())!;
        expect(card.x).toBeGreaterThanOrEqual(10);
        expect(card.x + card.width).toBeLessThanOrEqual(width - 10);
        expect(card.y).toBeGreaterThanOrEqual(10);
        expect(card.y + card.height).toBeLessThanOrEqual(695);
        await expect(panel).not.toContainText(/剩余|更新于|上次更新/);
        const monthly = panel.getByRole("progressbar", {
          name: "月度已用 Credit",
        });
        await expect(monthly).toContainText("42%");
        const counts = panel.getByText("168,000/400,000", { exact: true });
        await expect(counts).toBeVisible();
        await expect(counts).toHaveCSS("font-weight", "600");
        const rowValue = (await counts.locator("..").boundingBox())!;
        const meter = (await monthly.boundingBox())!;
        expect(rowValue.x + rowValue.width).toBeCloseTo(
          meter.x + meter.width,
          0,
        );
        await panel.getByRole("tab", { name: "Token", exact: true }).click();
        await panel.getByRole("combobox", { name: "额度模型" }).click();
        await page
          .getByRole("option", { name: "GLM-5.3-CodeAgent", exact: true })
          .click();
        await expect(
          panel.getByRole("combobox", { name: "额度模型" }),
        ).toContainText("GLM-5.3-CodeAgent");
        await expect(
          panel.getByText("236.6k/1.2M", { exact: true }),
        ).toBeVisible();
        await panel.getByRole("combobox", { name: "额度模型" }).click();
        await page.getByRole("option", { name: "DeepSeek V4.1 Flash" }).click();
        await expect(
          panel.getByText("236.6k/2M", { exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByText("3.6M/600M", { exact: true }),
        ).toBeVisible();
        await panel.getByRole("combobox", { name: "额度模型" }).click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await expect(panel).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(trigger).toBeFocused();
      }
    });
  }
}

test("关闭浮框后停止 Token 轮询，Credit 圆环与 Token 模型无关", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/tests/visual/codeAgentQuotaFixture.html");
  const trigger = page.getByRole("button", {
    name: "CodeAgent 额度",
    exact: true,
  });
  await trigger.click();
  const ring = trigger.locator("[data-credit-ring]");
  const initial = await ring.getAttribute("stroke-dasharray");
  await page.getByRole("tab", { name: "Token", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "额度模型" })).toBeVisible();
  const before = await page.evaluate(() => window.quotaFixture.token.length);
  await page.evaluate(() => {
    window.quotaFixture.isTokenStale = true;
  });
  await page.clock.fastForward(15000);
  await expect
    .poll(() => page.evaluate(() => window.quotaFixture.token.length))
    .toBe(before + 1);
  await expect(ring).toHaveAttribute("stroke-dasharray", initial!);
  await expect(page.getByText("236.6k/1.2M", { exact: true })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Token" })).not.toContainText(
    /失败|无法|更新于/,
  );
  await trigger.click();
  const closed = await page.evaluate(() => window.quotaFixture.token.length);
  await page.clock.fastForward(30000);
  expect(await page.evaluate(() => window.quotaFixture.token.length)).toBe(
    closed,
  );
});
