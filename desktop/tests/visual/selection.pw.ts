import { expect, test } from "@playwright/test";
import { color, ratio } from "./contrast.ts";

test("技能卡片只滚动溢出的描述，并保持详情键盘入口", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const skills = await context.newPage();
  await skills.setViewportSize({ width: 390, height: 780 });
  await skills.goto("/tests/visual/sidebarTypographyFixture.html?collections");
  const library = skills.getByRole("region", { name: "技能管理" });
  const title = "发布准备和回滚预案的完整审查";
  const card = library.getByRole("article", { name: title });
  const detail = card.getByRole("button", { name: "查看 " + title + " 详情" });
  const desc = detail.getByText(/^审查发布准备/);
  const offset = () => desc.evaluate((el) => getComputedStyle(el).translate);
  const short = library.getByRole("article", { name: "旧版发布检查" });
  await short.hover();
  await expect(short.getByText("已替换")).toHaveCSS("translate", "none");
  await expect(short.getByRole("switch")).not.toBeChecked();

  await expect.poll(offset).toBe("none");
  await card.hover();
  await expect.poll(offset).not.toBe("none");
  await library.getByRole("heading", { name: "技能", exact: true }).hover();
  await expect.poll(offset).toBe("none");
  await detail.press("Shift");
  await expect.poll(offset).not.toBe("none");
  await skills.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(offset).toBe("none");

  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(detail.getByText(title)).toHaveCSS(
      "font-size",
      String(px) + "px",
    );
    await expect(detail).toBeFocused();
    await expect(card.getByRole("switch")).toBeChecked();
  }
  await detail.press("Enter");
  const dialog = skills.getByRole("dialog", { name: "技能详情" });
  await expect(dialog.getByText(/^审查发布准备、核对安装包/)).toBeVisible();
  await dialog.getByRole("button", { name: "关闭技能详情" }).click();
  await expect(detail).toBeFocused();
  const toggle = card.getByRole("switch");
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(dialog).toBeHidden();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
});

test("列表选择的长选项和分组随字号换行，展开时保留活动项、滚动及焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const selection = await context.newPage();
  await selection.setViewportSize({ width: 320, height: 630 });
  await selection.goto(
    "/tests/visual/uiScaleFixture.html?selection&long-options&secondary",
  );
  const trigger = selection.getByRole("combobox", { name: "可用工作区" });
  const list = selection.getByRole("listbox", { name: "可用工作区" });
  const first = list.getByRole("option", { name: /^工作区 1 ·/ });
  const last = list.getByRole("option", { name: /^工作区 22 ·/ });
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await trigger.press("ArrowDown");
  await trigger.press("End");
  const id = await last.getAttribute("id");
  expect(id).toBeTruthy();
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(last).toHaveCSS("font-size", `${px - 2}px`);
    await expect(list.getByText("归档项目")).toHaveCSS(
      "font-size",
      `${px - 2}px`,
    );
    await expect(trigger).toHaveAttribute("aria-activedescendant", id!);
    await expect(trigger).toBeFocused();
    await expect(last).toBeInViewport();
    const viewport = await list.boundingBox();
    expect(viewport!.x).toBeGreaterThanOrEqual(7);
    expect(viewport!.x + viewport!.width).toBeLessThanOrEqual(313);
    expect(
      await list.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
  await trigger.press("Enter");
  await expect(trigger).toContainText("工作区 22");
  await expect(list).toBeHidden();
  await trigger.press("ArrowDown");
  await trigger.press("Home");
  await expect(first).toBeInViewport();
  await trigger.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("工作区 22");
  await trigger.press("ArrowDown");
  await trigger.press("Tab");
  await expect(list).toBeHidden();
  await expect(trigger).not.toBeFocused();
});

test("定时任务编辑器实时切换外观时保留星期选择、焦点和任务名称", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const tasks = await context.newPage();
  await tasks.setViewportSize({ width: 430, height: 850 });
  await tasks.goto("/tests/visual/sidebarTypographyFixture.html?task-editor");
  const dialog = tasks.getByRole("dialog", { name: "编辑定时任务" });
  const name = dialog.getByRole("textbox", { name: "任务名称" });
  const monday = dialog.getByRole("checkbox", { name: "星期一" });
  const tuesday = dialog.getByRole("checkbox", { name: "星期二" });
  const chip = tuesday.locator("+ span");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await name.fill("发布前检查");
  await expect(monday).toBeChecked();
  await tuesday.press("Space");

  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(chip).toHaveCSS("font-size", `${px}px`);
    await expect(chip).not.toHaveCSS("box-shadow", "none");
    await expect(chip).toHaveCSS("min-width", "32px");
    await expect
      .poll(async () =>
        ratio(
          await color(chip, "color"),
          await color(chip, "background-color"),
        ),
      )
      .toBeGreaterThanOrEqual(4.5);
    await expect(monday).toBeChecked();
    await expect(tuesday).toBeChecked();
    await expect(tuesday).toBeFocused();
    await expect(name).toHaveValue("发布前检查");
  }

  await monday.press("Space");
  await expect(monday).not.toBeChecked();
  await expect(tuesday).toBeChecked();
  const advanced = dialog.getByRole("button", { name: "高级" });
  await advanced.press("Enter");
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(advanced).toBeFocused();
  await expect(advanced).not.toHaveCSS("box-shadow", "none");

  await dialog
    .getByRole("button", { name: "取消", exact: true })
    .press("Enter");
  await tasks.setViewportSize({ width: 320, height: 850 });
  const heading = tasks.getByRole("heading", { level: 1 });
  const run = tasks.getByRole("button", { name: "立即运行" });
  await run.press("Shift");
  await page.getByRole("button", { name: "暗夜", exact: true }).click();
  await font.fill("20");
  await font.press("Enter");
  await expect(heading).toHaveCSS("font-size", "22px");
  await expect(run).toBeFocused();
  const header = heading.locator("xpath=ancestor::header");
  expect(await header.evaluate((el) => el.scrollWidth)).toBe(
    await header.evaluate((el) => el.clientWidth),
  );
});

test("问答单选支持方向键和选中焦点，多选保留独立选项，提交时禁用", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/visual/uiScaleFixture.html?selection");
  const single = page.getByRole("group", { name: "问答单选" });
  const multiple = page.getByRole("group", { name: "问答多选" });
  const first = single.getByRole("radio", { name: "一", exact: true });
  const second = single.getByRole("radio", { name: "二", exact: true });
  const field = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await field.fill(String(px));
    await field.press("Enter");
    await first.press("Home");
    await expect(first).toBeChecked();
    await first.press("ArrowDown");
    await expect(second).toBeChecked();
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("tabindex", "0");
    await expect(first).toHaveAttribute("tabindex", "-1");
    await expect(second).toHaveCSS("font-size", px + "px");
    await expect(second).not.toHaveCSS("box-shadow", "none");
    await expect
      .poll(() => color(second, "background-color"))
      .toEqual(await color(second, "--color-selected"));
    const mark = second.locator("[aria-hidden]").first();
    expect(
      parseFloat(await mark.evaluate((el) => getComputedStyle(el).width)),
    ).toBeCloseTo((px * 20) / 14, 1);
    await second.press("Space");
    await expect(second).not.toBeChecked();
    for (const name of ["一", "二"]) {
      const checkbox = multiple.getByRole("checkbox", { name, exact: true });
      await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
    }
    for (const checkbox of await multiple.getByRole("checkbox").all()) {
      await expect(checkbox).toBeChecked();
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
    }
    await expect(
      page
        .getByRole("group", { name: "正在提交" })
        .getByRole("radio", { name: "一", exact: true }),
    ).toBeDisabled();
    expect(
      await single.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
});

for (const theme of ["暖白", "暗夜"]) {
  test(
    theme + " 下的选择控件覆盖三档字号、选中、禁用和键盘操作",
    async ({ page }) => {
      await page.goto("/tests/visual/uiScaleFixture.html?selection");
      await page.getByRole("button", { name: theme, exact: true }).click();
      const section = page.getByRole("region", { name: "选择控件" });
      const checkbox = section.getByRole("checkbox", {
        name: "复选",
        exact: true,
      });
      const size = page.getByRole("spinbutton", { name: "界面字号" });
      for (const px of [12, 14, 20]) {
        await size.fill(String(px));
        await size.press("Enter");
        await checkbox.press("Space");
        await expect(checkbox).toBeChecked();
        const box = checkbox.locator("+ span");
        expect((await box.boundingBox())!.width).toBeCloseTo((16 * px) / 14, 1);
        await expect(box).not.toHaveCSS("box-shadow", "none");
        await expect
          .poll(() => color(box, "background-color"))
          .toEqual(await color(box, "--color-info-bg"));
        await expect(
          section.getByRole("checkbox", { name: "禁用复选" }),
        ).toBeDisabled();
        const pill = section.getByRole("checkbox", {
          name: "圆形复选",
          exact: true,
        });
        await pill.press("Shift");
        const circle = pill.locator("+ span");
        await expect(circle).toHaveCSS("font-size", `${px}px`);
        await expect(circle).not.toHaveCSS("box-shadow", "none");
        await expect
          .poll(() => color(circle, "background-color"))
          .toEqual(await color(circle, "--color-ink"));
        await expect(
          section.getByRole("checkbox", { name: "禁用圆形复选" }),
        ).toBeDisabled();
        for (const kind of ["accent", "neutral"]) {
          const toggle = section.getByRole("switch", {
            name: kind + " 开关",
            exact: true,
          });
          await toggle.press("Space");
          await expect(toggle).not.toBeChecked();
          await toggle.press("Space");
          await expect(toggle).toBeChecked();
          const track = toggle.locator("+ span");
          expect((await track.boundingBox())!.width).toBeCloseTo(
            ((kind === "neutral" ? 32 : 28) * px) / 14,
            1,
          );
          await expect(track).not.toHaveCSS("box-shadow", "none");
          await expect
            .poll(() => color(track, "background-color"))
            .toEqual(
              await color(
                track,
                kind === "neutral" ? "--color-ink" : "--color-accent-ink",
              ),
            );
          await expect(
            section.getByRole("switch", { name: kind + " 禁用开关" }),
          ).toBeDisabled();
          await section
            .getByRole("radio", { name: kind + "一" })
            .press("ArrowRight");
          const radio = section.getByRole("radio", { name: kind + "二" });
          await expect(radio).toBeChecked();
          const dot = radio.locator("+ span");
          await expect(dot).not.toHaveCSS("box-shadow", "none");
          expect((await dot.boundingBox())!.width).toBeCloseTo(
            (16 * px) / 14,
            1,
          );
        }
        for (const kind of ["default", "quiet"]) {
          const list = section.getByRole("combobox", {
            name: kind + " 列表",
            exact: true,
          });
          await list.press("Enter");
          await expect(list).toHaveCSS("font-size", `${px - 2}px`);
          const option = section.getByRole("option", { name: "二" });
          await expect(option).toHaveCSS("font-size", `${px - 2}px`);
          await expect(option).toHaveAttribute("aria-selected", "true");
          await expect
            .poll(() => color(option, "background-color"))
            .toEqual(await color(option, "--color-selected"));
          await list.press("Escape");
          await expect(list).toBeFocused();
          await expect(
            section.getByRole("combobox", { name: kind + " 禁用列表" }),
          ).toBeDisabled();
        }
        const tabs = section.getByRole("tablist");
        await tabs.getByRole("tab", { name: "二" }).press("Home");
        await expect(tabs.getByRole("tab", { name: "一" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        const segments = section.getByRole("group", { name: "分段选择" });
        await expect(
          segments.getByRole("button", { name: "一" }),
        ).toHaveAttribute("aria-pressed", "true");
        const warning = segments.getByRole("button", { name: "二" });
        await warning.press("Space");
        await expect(warning).toHaveAttribute("aria-pressed", "true");
        await expect(warning).toHaveCSS("font-size", `${px - 1}px`);
        await expect(warning).not.toHaveCSS("box-shadow", "none");
        await expect
          .poll(() => color(warning, "color"))
          .toEqual(await color(warning, "--color-warn-ink"));
        await checkbox.press("Space");
        await expect(checkbox).not.toBeChecked();
      }
    },
  );
}
