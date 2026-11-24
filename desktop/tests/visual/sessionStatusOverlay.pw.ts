import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

test("运行中模型可刷新，滚动列表时操作固定，换肤与字号保留焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 330, height: 660 });
  await session.goto(
    "/tests/visual/sessionStatusOverlayFixture.html?appearance&model-refresh",
  );
  const model = session.getByRole("button", { name: "模型选择" });
  const menu = session.getByRole("menu", { name: "模型选择" });
  const refresh = menu.getByRole("menuitem", { name: "刷新模型" });
  const firstModel = menu.getByRole("menuitemradio", {
    name: "模型 1",
    exact: true,
  });
  const list = firstModel.locator("..");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await model.press("Enter");
  await menu.press("Home");
  await expect(refresh).toBeFocused();
  await refresh.press("Enter");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "最新模型" }),
  ).toBeAttached();
  await expect(firstModel).toBeChecked();
  await list.hover();
  await session.mouse.wheel(0, 70);
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await menu.evaluate((element) => element.scrollTop)).toBe(0);
  const refreshBox = (await refresh.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(listBox.y).toBeGreaterThanOrEqual(refreshBox.y + refreshBox.height);
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(refresh).toBeFocused();
    await expect
      .poll(() =>
        refresh
          .locator("svg")
          .evaluate((svg) => parseFloat(getComputedStyle(svg).inlineSize)),
      )
      .toBeCloseTo((px * 16) / 14, 1);
    const initialY = (await refresh.boundingBox())!.y;
    await refresh.press("End");
    await expect(
      menu.getByRole("menuitemradio", { name: "最新模型" }),
    ).toBeFocused();
    expect((await refresh.boundingBox())!.y).toBeCloseTo(initialY);
    await session.keyboard.press("Home");
    await expect(refresh).toBeFocused();
  }
  await refresh.press("Escape");
  await expect(menu).toBeHidden();
  await expect(model).toBeFocused();
});

test("连接失败和会话归档共用提示条，窄窗换肤保留操作焦点", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 320, height: 660 });
  await session.goto("/tests/visual/sessionStatusOverlayFixture.html?appearance&right-panel&conversation-header&connection-error&archive-notice");
  const error = session.getByRole("alert").filter({ hasText: "连接失败" });
  const archive = session.getByRole("status", { name: "归档提示" });
  const settings = error.getByRole("button", { name: "打开设置" });
  await session.getByRole("button", { name: "演示归档" }).press("Enter");
  const undo = archive.getByRole("button", { name: "撤销" });
  await undo.focus();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(archive).toHaveCSS("font-size", `${px - 2}px`);
    await expect(undo).toBeFocused();
    await expect(error).toContainText("检查项目的可执行文件路径");
    for (const notice of [archive, error]) {
      expect(await notice.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(ratio(await color(archive, "color"), await color(archive, "background-color"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(
      await color(error, "color"),
      blend(await color(error, "background-color"), await color(error, "--color-base")),
    )).toBeGreaterThanOrEqual(4.5);
  }
  await undo.press("Enter");
  await expect(archive).toBeHidden();
  await settings.press("Enter");
  await expect(session.locator("html")).toHaveAttribute("data-opened-agent-settings", "true");
  await error.getByRole("button", { name: "关闭错误提示" }).press("Enter");
  await expect(error).toBeHidden();
});

test("状态卡显示菜单换肤保留活动项，Esc 和选择各自归还焦点", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 360, height: 660 });
  await session.goto("/tests/visual/sessionStatusOverlayFixture.html?appearance");
  const capsule = session.getByRole("button", { name: /^展开会话状态/ });
  await capsule.press("Enter");
  const trigger = session.getByRole("button", { name: "状态卡显示选项" });
  const menu = session.getByRole("menu", { name: "状态卡显示选项" });
  const automatic = menu.getByRole("menuitem", { name: "恢复自动展开" });
  await trigger.press("Enter");
  await menu.press("ArrowDown");
  await expect(automatic).toBeFocused();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(automatic).toHaveCSS("font-size", `${px}px`);
    await expect(automatic).toBeFocused();
    expect(await color(menu, "background-color")).toEqual(await color(menu, "--color-menu"));
    expect(ratio(await color(automatic, "color"), await color(automatic, "background-color"))).toBeGreaterThanOrEqual(4.5);
  }
  await automatic.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Space");
  await menu.press("Home");
  await automatic.press("Enter");
  await expect(menu).toBeHidden();
  await expect(capsule).toBeFocused();
});

test("信息流模型与审批菜单共用键盘选择，外观往返保留菜单焦点与消息草稿", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 330, height: 660 });
  await session.goto("/tests/visual/sessionStatusOverlayFixture.html?appearance&composer-selection");
  const composer = session.getByRole("textbox", { name: "消息输入框" });
  const model = session.getByRole("button", { name: "模型选择" });
  const modelMenu = session.getByRole("menu", { name: "模型选择" });
  const review = modelMenu.getByRole("menuitemradio", { name: "审核模型" });
  await composer.fill("整理发布记录");
  await model.press("Enter");
  await expect(modelMenu).toBeFocused();
  await modelMenu.press("End");
  await expect(review).toBeFocused();

  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(review).toBeFocused();
    await expect(review).toHaveCSS("font-size", `${px}px`);
    await expect(review).not.toHaveCSS("box-shadow", "none");
    await expect(modelMenu.getByRole("menuitemradio", { name: "快速模型" })).toBeChecked();
    const base = await color(modelMenu, "background-color");
    const hover = blend(await color(review, "background-color"), base);
    expect(ratio(await color(review, "color"), hover)).toBeGreaterThanOrEqual(4.5);
    await expect(composer).toHaveValue("整理发布记录");
    await expect(composer).toHaveCSS("outline-style", "none");
    const menuBox = (await modelMenu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(7);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(323);
  }

  await review.press("Enter");
  await expect(modelMenu).toBeHidden();
  await expect(model).toBeFocused();
  await expect(model).toHaveText("审核模型");
  const approval = session.getByRole("button", { name: "审批默认模式" });
  const approvalMenu = session.getByRole("menu", { name: "审批默认模式" });
  await approval.press("Enter");
  await approvalMenu.press("ArrowDown");
  await expect(approvalMenu.getByRole("menuitemradio", { name: "每次询问" })).toBeFocused();
  await session.keyboard.press("Escape");
  await expect(approvalMenu).toBeHidden();
  await expect(approval).toBeFocused();
  await expect(composer).toHaveValue("整理发布记录");
});

test("提问轨道支持键盘跨越虚拟窗口，换肤时保留当前提问和焦点", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 1180, height: 720 });
  await session.goto("/tests/visual/sessionStatusOverlayFixture.html?appearance&long-navigation");
  const rail = session.getByRole("navigation", { name: "提问导航" });
  const first = rail.getByRole("button", { name: "跳到第 1 条提问", exact: true });
  const last = rail.getByRole("button", { name: "跳到第 90 条提问", exact: true });
  await rail.getByRole("button").last().press("Home");
  await expect(first).toBeFocused();
  await first.press("End");
  await expect(last).toBeFocused();
  const previous = rail.getByRole("button", { name: "跳到第 89 条提问", exact: true });
  await last.press("ArrowUp");
  await expect(previous).toBeFocused();
  await previous.press("Enter");
  await expect(previous).toHaveAttribute("aria-current", "location");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect.poll(() => previous.locator("span").evaluate(el => parseFloat(getComputedStyle(el).width))).toBeCloseTo(12 * px / 14, 1);
    await expect(previous).toHaveAttribute("aria-current", "location");
    await expect(previous).toBeFocused();
    await expect(previous).not.toHaveCSS("box-shadow", "none");
    await expect(session.locator('[data-query-id="user-88"]')).toBeInViewport();
    const label = previous.locator("span");
    const marker = await label.boundingBox();
    const row = await previous.boundingBox();
    expect(marker!.x + marker!.width).toBeLessThanOrEqual(row!.x + row!.width + 1);
  }
  await session.locator("[data-session-messages]").hover();
  await session.mouse.wheel(0, -1000);
  await expect(rail.locator('[aria-current="location"]')).not.toHaveAttribute("data-query-row", "88");
});

test("真实消息编辑器换肤和调字号时保持草稿、选区和插入光标", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const session = await context.newPage();
  await session.setViewportSize({ width: 390, height: 740 });
  await session.goto("/tests/visual/sessionStatusOverlayFixture.html?appearance");
  const input = session.getByRole("textbox", { name: "消息输入框" });
  const card = session.locator(".composer-card");
  await input.fill("保持选区的草稿");
  await input.press("Home");
  await input.press("Shift+ArrowRight");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(input).toHaveCSS("font-size", px + "px");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("保持选区的草稿");
    expect(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 1]);
    expect(ratio(await color(input, "caret-color"), await color(card, "background-color"))).toBeGreaterThanOrEqual(4.5);
    expect(await card.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("两种主题下，消息编辑区在悬停、键盘聚焦和输入时都没有描边", async ({ page }) => {
  await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const card = page.locator(".composer-card");
  async function checkSurface() {
    for (const element of [input, card]) {
      for (const side of ["top", "right", "bottom", "left"])
        await expect(element).toHaveCSS("border-" + side + "-width", "0px");
      await expect(element).toHaveCSS("box-shadow", "none");
      await expect(element).toHaveCSS("outline-style", "none");
    }
  }
  for (const warm of [true, false]) {
    await page.evaluate(value => document.documentElement.classList.toggle("theme-warm", value), warm);
    await input.evaluate((el: HTMLTextAreaElement) => el.blur());
    await page.mouse.move(0, 0);
    await checkSurface();
    await input.hover();
    await checkSurface();
    await input.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();
    await input.fill("消息草稿");
    await checkSurface();
    await expect(input).toHaveValue("消息草稿");
  }
});

for (const width of [1550, 950]) {
  test(`session status overlays the full-width chat without moving it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
    const messages = page.getByRole("log", { name: "消息流" });
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await expect(input).toBeVisible();
    await input.fill("输入区草稿");
    await messages.hover({ position: { x: 120, y: 150 } });
    await page.mouse.wheel(0, -550);
    await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();

    const layout = () => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>("[data-session-messages]")!;
      const message = scroll.querySelector<HTMLElement>('[data-item-kind="assistant"]')!;
      const composer = document.querySelector<HTMLElement>(".composer-card")!;
      const box = (element: HTMLElement) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { message: box(message), composer: box(composer), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    });
    const original = await layout();
    const capsule = page.getByRole("button", { name: /^展开会话状态/ });
    const collapse = page.getByRole("button", { name: "收起会话状态" });
    const panel = page.locator(".session-status-panel");

    await capsule.click();
    expect(await layout()).toEqual(original);
    await expect(panel).toHaveCSS("opacity", "1");
    expect(await layout()).toEqual(original);
    await input.click();
    await expect(input).toHaveValue("输入区草稿");
    await expect(panel).toBeVisible();
    expect(await layout()).toEqual(original);

    await collapse.click();
    expect(await layout()).toEqual(original);
    await expect(panel).toBeHidden();
    expect(await layout()).toEqual(original);

    await capsule.click();
    await page.getByRole("button", { name: "状态卡显示选项" }).click();
    await page.getByRole("menuitem", { name: "恢复自动展开" }).click();
    if (width >= 1280) await expect(panel).toHaveCSS("opacity", "1");
    else await expect(panel).toBeHidden();
    expect(await layout()).toEqual(original);
  });
}

test("session status sections animate through the shared tree branch", async ({ page }) => {
  await page.setViewportSize({ width: 950, height: 760 });
  await page.goto("/tests/visual/sessionStatusOverlayFixture.html");
  await page.getByRole("button", { name: /^展开会话状态/ }).click();
  const toggle = page.getByRole("button", { name: "Git 工具" });
  const heights = await toggle.evaluate(async (button) => {
    const branch = document.getElementById(button.getAttribute("aria-controls")!)!;
    const height = () => branch.getBoundingClientRect().height;
    const openHeight = height();
    (button as HTMLButtonElement).click();
    const samples = [];
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(height());
    }
    return { openHeight, samples };
  });
  expect(heights.samples.some((height) => height > 0 && height < heights.openHeight)).toBe(true);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(heights.samples.at(-1)).toBe(0);
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("正在读取 Git 状态…")).toBeVisible();
});
