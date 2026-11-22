import { expect, test } from "@playwright/test";

test("终端高度支持拖动与键盘调节，换肤及收起后保留高度和输出", async ({ page }) => {
  await page.goto("/tests/visual/uiScaleFixture.html?terminal-dock");
  const open = page.getByRole("button", { name: "终端", exact: true });
  await open.press("Enter");
  const divider = page.getByRole("separator", { name: "调整终端面板高度" });
  const panel = page.getByTestId("terminal-panel");
  const output = panel.locator(".xterm-rows");
  await expect(output).toContainText("Desktop appearance test");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await divider.press("Home");
  const initial = Number(await divider.getAttribute("aria-valuenow"));
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 8, { steps: 2 });
  await page.mouse.up();
  await expect(panel).toHaveCSS("height", initial + 8 + "px");
  await divider.press("ArrowUp");
  await expect(divider).toHaveAttribute("aria-valuenow", (await divider.getAttribute("aria-valuemax"))!);
  const height = await divider.getAttribute("aria-valuenow");
  await page.getByRole("button", { name: "暖白", exact: true }).evaluate((el: HTMLElement) => el.click());
  await expect(page.locator("html")).toHaveClass(/theme-warm/);
  await expect(divider).toBeFocused();
  await expect(divider.locator("[aria-hidden]")).toHaveCSS("opacity", "1");
  await expect(output).toContainText("Desktop appearance test");
  await open.press("Enter");
  await expect(divider).toHaveCount(0);
  await open.press("Enter");
  await expect(divider).toHaveAttribute("aria-valuenow", height!);
  await expect(output).toContainText("Desktop appearance test");
});

test("终端页签切换外观时保留焦点，键盘关闭后返回页签或工具栏", async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 850 });
  await page.goto("/tests/visual/uiScaleFixture.html?terminal-dock");
  const open = page.getByRole("button", { name: "终端", exact: true });
  await open.press("Enter");
  await expect(open).toHaveAttribute("aria-pressed", "true");
  const list = page.getByRole("tablist", { name: "终端页签" });
  const first = list.getByRole("tab").first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "新建终端页签" }).click();
  const second = list.getByRole("tab").nth(1);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await second.press("ArrowLeft");
  await expect(first).toBeFocused();
  const theme = page.getByRole("button", { name: "暖白", exact: true });
  await theme.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("html")).toHaveClass(/theme-warm/);
  await expect(first).toBeFocused();
  await expect(first).not.toHaveCSS("box-shadow", "none");

  await first.press("Tab");
  const close = first.getByRole("button", { name: /关闭页签/ });
  await expect(close).toBeFocused();
  await expect(close).not.toHaveCSS("box-shadow", "none");
  await close.press("Space");
  await expect(list.getByRole("tab")).toHaveCount(1);
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await first.press("Delete");
  await expect(list).toBeHidden();
  await expect(open).toHaveAttribute("aria-pressed", "false");
  await expect(open).toBeFocused();
  await expect(open).not.toHaveCSS("box-shadow", "none");
});

test("通过外观设置往返换肤和调整字号时，终端保留输出并继续接收输入", async ({
  page,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html?terminal");
  const host = page.getByRole("tabpanel");
  const rows = host.locator(".xterm-rows");
  await expect(rows).toContainText("Desktop appearance test");
  const viewport = host.locator(".xterm-viewport");
  const readColor = () =>
    viewport.evaluate((el) => getComputedStyle(el).backgroundColor);
  const dark = await readColor();
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    if (theme === "暗夜") await expect.poll(readColor).toBe(dark);
    else await expect.poll(readColor).not.toBe(dark);
    await size.fill(String(px));
    await size.press("Enter");
    await expect(host).toHaveCSS("font-size", px - 1 + "px");
    await expect(rows).toContainText("Desktop appearance test");
  }
  await host.locator("textarea").press("x");
  await expect(rows).toContainText("$ x");
});
