import { expect, test } from "@playwright/test";
import { color, ratio } from "./contrast.ts";

test("浏览器地址、视口尺寸和页面输入使用当前主题并保留草稿", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const browser = await context.newPage();
  await browser.goto(
    "/tests/visual/uiScaleFixture.html?secondary&browser-appearance",
  );
  const prompt = await context.newPage();
  await prompt.goto(
    "/tests/visual/uiScaleFixture.html?secondary&browser-appearance&browser-prompt",
  );
  const settings = await context.newPage();
  await settings.goto(
    "/tests/visual/uiScaleFixture.html?secondary&browser-appearance",
  );
  await settings
    .getByRole("button", { name: "浏览器数据管理", exact: true })
    .click();
  const data = settings.getByRole("dialog", { name: "浏览器数据管理" });
  const pageDialog = prompt.getByRole("dialog", { name: "页面对话框" });
  await expect(data).toHaveAttribute("data-hint-open", "true");
  await expect(pageDialog).toHaveAttribute("data-hint-open", "true");
  const width = data.getByRole("spinbutton", { name: "自由视口宽" });
  const height = data.getByRole("spinbutton", { name: "自由视口高" });
  await width.fill("1024");
  await height.press("Shift+Tab");
  const address = browser.getByRole("textbox", { name: "地址栏" });
  await address.fill("https://example.test/draft");
  const input = pageDialog.getByRole("textbox", { name: "对话框输入" });
  await input.fill("讨论记录");
  await input.press("Home");
  await input.press("Shift+ArrowRight");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(input).toHaveCSS("font-size", `${px}px`);
    await expect(address).toHaveCSS("font-size", `${px - 2}px`);
    await expect(width).toHaveCSS("font-size", `${px - 2}px`);
    await expect(height).toHaveCSS("font-size", `${px - 2}px`);
    await expect(input).toBeFocused();
    await expect(address).toBeFocused();
    await expect(width).toBeFocused();
    await expect(width).not.toHaveCSS("box-shadow", "none");
    await expect(width).toHaveValue("1024");
    await expect(input).toHaveValue("讨论记录");
    await expect(address).toHaveValue("https://example.test/draft");
    for (const surface of [data, pageDialog]) {
      expect(await color(surface, "background-color")).toEqual(
        await color(surface, "--color-surface"),
      );
    }
    expect(
      await input.evaluate((el: HTMLInputElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, 1]);
    for (const field of [address, input, width, height]) {
      expect(await color(field, "background-color")).toEqual(
        await color(field, "--color-base"),
      );
      expect(
        ratio(
          await color(field, "color"),
          await color(field, "background-color"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  await data
    .getByRole("checkbox", { name: "重启后恢复合法标签 URL" })
    .press("Space");
  await expect(data.getByRole("checkbox")).toBeChecked();
});

test("浏览器清理确认跟随外观，Esc 归还发起按钮焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const browser = await context.newPage();
  await browser.setViewportSize({ width: 360, height: 680 });
  await browser.goto(
    "/tests/visual/uiScaleFixture.html?secondary&browser-appearance",
  );
  await browser
    .getByRole("button", { name: "浏览器数据管理", exact: true })
    .press("Enter");
  const data = browser.getByRole("dialog", { name: "浏览器数据管理" });
  const trigger = data.getByRole("button", { name: "清除全部浏览器数据" });
  await trigger.press("Enter");
  const confirm = data.getByRole("group", { name: "确认清理浏览器数据" });
  const cancel = confirm.getByRole("button", { name: "取消", exact: true });
  const proceed = confirm.getByRole("button", {
    name: "确认清理",
    exact: true,
  });
  const message = confirm.getByRole("alert");
  await expect(cancel).toBeFocused();
  await expect(message).toContainText("已完成的子项不会因取消而回滚");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(cancel).toBeFocused();
    await expect(message).toHaveCSS("font-size", `${px - 2}px`);
    await expect(proceed).toBeEnabled();
    expect(
      await confirm.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await cancel.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(trigger).toBeFocused();
});
