import { expect, test, type Locator, type Page } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

const sample = "/tests/visual/uiScaleFixture.html?feedback-controls&secondary";
const appearances = [
  ["暖白", 12],
  ["暗夜", 20],
  ["暖白", 14],
] as const;

async function applyAppearance(settings: Page, theme: string, px: number) {
  await settings.getByRole("button", { name: theme, exact: true }).click();
  const input = settings.getByRole("spinbutton", { name: "界面字号" });
  await input.fill(String(px));
  await input.press("Enter");
}

async function textContrast(text: Locator, surface: Locator) {
  const page = await color(surface, "--color-base");
  const background = blend(await color(surface, "background-color"), page);
  const textBackground = blend(
    await color(text, "background-color"),
    background,
  );
  return ratio(await color(text, "color"), textBackground);
}

test("五种提示条在双主题三档字号下显示语义色、可展开详情并可键盘关闭", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const feedback = await context.newPage();
  await feedback.setViewportSize({ width: 320, height: 680 });
  await feedback.goto(sample);
  const labels = [
    ["会话已归档", "line-strong", "ink-mute"],
    ["工作流改动尚未保存", "info-line", "info-ink"],
    ["运行报告已生成", "ok-line", "ok-ink"],
    ["等待执行权限确认", "warn-line", "warn-ink"],
    ["读取发布记录失败", "danger-line", "danger-ink"],
  ] as const;
  const error = feedback.getByRole("alert", { name: "读取发布记录失败" });
  await error.getByText("详情", { exact: true }).press("Enter");
  const close = error.getByRole("button", { name: "关闭提示" });
  await close.focus();
  for (const [theme, px] of appearances) {
    await applyAppearance(page, theme, px);
    await expect(feedback.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    for (const [name, border, ink] of labels) {
      const surface = feedback.getByRole(
        name === labels[4][0] ? "alert" : "status",
        { name },
      );
      const icon = surface.locator("svg").first();
      expect(await color(surface, "border-top-color")).toEqual(
        await color(surface, "--color-" + border),
      );
      expect(await color(icon, "color")).toEqual(
        await color(icon, "--color-" + ink),
      );
      expect((await icon.boundingBox())!.width).toBeCloseTo((16 * px) / 14, 1);
      await expect(surface).toHaveCSS("font-size", `${px - 2}px`);
      expect(
        await textContrast(surface.getByText(name, { exact: true }), surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await surface.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await expect(error.getByText("E_RELEASE_LOG_UNAVAILABLE")).toBeVisible();
    await expect(close).toBeFocused();
  }
  await close.press("Enter");
  await expect(error).toBeHidden();
});

test("项目菜单验证默认、悬停、按下、焦点、勾选、禁用和危险操作", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const feedback = await context.newPage();
  await feedback.setViewportSize({ width: 320, height: 560 });
  await feedback.goto(sample);
  const trigger = feedback.getByRole("button", { name: "操作菜单" });
  const menu = feedback.getByRole("menu", { name: "项目操作" });
  const regular = menu.getByRole("menuitem", { name: /^导出发布记录/ });
  const warning = menu.getByRole("menuitem", { name: "重试连接" });
  const danger = menu.getByRole("menuitem", { name: "删除归档记录" });
  const disabled = menu.getByRole("menuitem", { name: "恢复删除的记录" });
  const checkbox = menu.getByRole("menuitemcheckbox", { name: "区分大小写" });
  const radio = menu.getByRole("menuitemradio", { name: "预览模式" });
  await trigger.press("Enter");
  for (const [theme, px] of appearances) {
    await applyAppearance(page, theme, px);
    await expect(regular).toHaveCSS("font-size", `${px}px`);
    expect(await color(menu, "background-color")).toEqual(
      await color(menu, "--color-menu"),
    );
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(7.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(312.5);
    expect(
      await regular.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(await textContrast(warning, menu)).toBeGreaterThanOrEqual(4.5);
    expect(await textContrast(danger, menu)).toBeGreaterThanOrEqual(4.5);
    await expect(checkbox).toBeChecked();
    await expect(radio).toBeChecked();
    for (const item of [checkbox, radio]) {
      const checkmark = item.locator("svg");
      await expect(checkmark).toBeVisible();
      expect((await checkmark.boundingBox())!.width).toBeCloseTo(
        (16 * px) / 14,
        1,
      );
    }
    await expect(disabled).toBeDisabled();
    expect(await color(disabled, "color")).toEqual(
      await color(disabled, "--color-ink-subtlest"),
    );
    await regular.hover();
    expect(await color(regular, "background-color")).toEqual(
      await color(regular, "--color-menu-hover"),
    );
    await feedback.mouse.down();
    try {
      expect(await regular.evaluate((el) => el.matches(":active"))).toBe(true);
      expect(await textContrast(regular, menu)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await feedback.mouse.move(1, 1);
      await feedback.mouse.up();
    }
    await regular.press("End");
    await expect(danger).toBeFocused();
    expect(await textContrast(danger, menu)).toBeGreaterThanOrEqual(4.5);
    await danger.press("ArrowUp");
    await expect(radio).toBeFocused();
    expect(await color(radio, "background-color")).toEqual(
      await color(radio, "--color-menu-hover"),
    );
  }
  await radio.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("中性与危险确认保留取消焦点、处理禁用态并归还入口焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const feedback = await context.newPage();
  await feedback.setViewportSize({ width: 320, height: 640 });
  await feedback.goto(sample);
  const remove = feedback.getByRole("button", { name: "删除确认" });
  const exit = feedback.getByRole("button", { name: "退出确认" });
  const inlineTrigger = feedback.getByRole("button", { name: "放弃草稿" });
  const icon = feedback.getByRole("button", { name: "移除记录", exact: true });
  for (const [theme, px] of appearances) {
    await applyAppearance(page, theme, px);
    await expect(feedback.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await remove.press("Enter");
    const dialog = feedback.getByRole("alertdialog", { name: "删除归档记录" });
    const proceed = dialog.getByRole("button", { name: "删除" });
    const cancel = dialog.getByRole("button", { name: "取消" });
    await expect(cancel).toBeFocused();
    await expect(proceed).toBeDisabled();
    await expect(proceed).toHaveCSS("font-size", `${px}px`);
    await dialog
      .getByRole("checkbox", { name: "已核对清理范围" })
      .press("Space");
    await expect(proceed).toBeEnabled();
    await proceed.hover();
    expect(await textContrast(proceed, dialog)).toBeGreaterThanOrEqual(4.5);
    await cancel.press("Escape");
    await expect(remove).toBeFocused();
    await exit.press("Enter");
    const quit = feedback.getByRole("dialog", { name: "退出应用" });
    const quitAction = quit.getByRole("button", { name: "退出" });
    await expect(quit.getByRole("button", { name: "取消" })).toBeFocused();
    expect(await textContrast(quitAction, quit)).toBeGreaterThanOrEqual(4.5);
    await quitAction.press("Escape");
    await expect(exit).toBeFocused();
    const busy = feedback.getByRole("checkbox", { name: "模拟提交中" });
    await busy.press("Space");
    await expect(busy).toBeChecked();
    await inlineTrigger.press("Enter");
    const inline = feedback.getByRole("group", { name: "确认放弃草稿" });
    const stop = inline.getByRole("button", { name: "取消" });
    await expect(stop).toBeFocused();
    await expect(inline.getByRole("button", { name: "放弃" })).toBeDisabled();
    await stop.press("Escape");
    await expect(inline).toBeHidden();
    await expect(inlineTrigger).toBeFocused();
    await busy.press("Space");
    await expect(busy).not.toBeChecked();
    await icon.press("Enter");
    const inlineIcon = feedback.getByRole("button", { name: "确认移除记录" });
    await expect(inlineIcon).toBeFocused();
    expect(
      ratio(
        await color(inlineIcon, "color"),
        await color(inlineIcon, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    await inlineIcon.press("Escape");
    await expect(icon).toBeFocused();
  }
});
