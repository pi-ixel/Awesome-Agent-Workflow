import { expect, test, type Page } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

for (const theme of ["暖白", "暗夜"]) {
  test(`${theme} 下的五种导航行在三档字号下保留点击区、悬停和键盘焦点`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 850 });
    await page.goto("/tests/visual/uiScaleFixture.html?navigation-rows");
    await page.getByRole("button", { name: theme, exact: true }).click();
    const region = page.getByRole("region", { name: "共享导航行" });
    const base = await color(region, "background-color");
    const font = page.getByRole("spinbutton", { name: "界面字号" });
    for (const px of [12, 14, 20]) {
      await font.fill(String(px));
      await font.press("Enter");
      await expect(page.locator("html")).toHaveCSS("--ui-font-size", `${px}px`);
      for (const layout of ["list", "tree", "choice", "compound", "launcher"]) {
        const group = region.getByTestId(layout);
        const normal = group.getByRole("button", { name: "默认" });
        const selected = group.getByRole("button", { name: "选中" });
        const disabled = group.getByRole("button", { name: "禁用" });
        const surface = layout === "compound" ? normal.locator("..") : normal;
        const selection =
          layout === "compound" ? selected.locator("..") : selected;
        const disabledSurface =
          layout === "compound" ? disabled.locator("..") : disabled;
        await expect(normal).toHaveCSS(
          "font-size",
          `${layout === "choice" || layout === "launcher" ? px : px - 2}px`,
        );
        expect((await normal.boundingBox())!.height).toBeGreaterThanOrEqual(
          layout === "tree" ? 28 : 32,
        );
        const iconWidth = await normal
          .locator("svg")
          .evaluate((icon) => icon.getBoundingClientRect().width);
        expect(iconWidth).toBeCloseTo((16 * px) / 14, 1);
        await disabled.hover();
        await expect(disabled).toBeDisabled();
        await expect(disabled).toHaveCSS(
          "opacity",
          theme === "暗夜" ? "0.7" : "0.5",
        );
        await expect
          .poll(() => color(disabledSurface, "background-color"))
          .toEqual([0, 0, 0, 0]);
        await expect
          .poll(() => color(surface, "background-color"))
          .toEqual([0, 0, 0, 0]);
        expect(
          ratio(await color(normal, "color"), base),
        ).toBeGreaterThanOrEqual(4.5);
        await normal.hover();
        const hover = await color(normal, "--color-surface-hover");
        await expect
          .poll(() => color(surface, "background-color"))
          .toEqual(hover);
        expect(
          ratio(await color(normal, "color"), blend(hover, base)),
        ).toBeGreaterThanOrEqual(4.5);
        const selectedColor = await color(selected, "--color-selected");
        await expect
          .poll(() => color(selection, "background-color"))
          .toEqual(selectedColor);
        await page.mouse.down();
        await expect
          .poll(() => color(surface, "background-color"))
          .toEqual(hover);
        await page.mouse.up();
        await normal.press("Tab");
        await expect(selected).toBeFocused();
        await expect(selected).not.toHaveCSS("box-shadow", "none");
        const selectedBackground = blend(selectedColor, base);
        expect(
          ratio(await color(selected, "color"), selectedBackground),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          ratio(
            await color(selected, "--color-focus-ring"),
            selectedBackground,
          ),
        ).toBeGreaterThanOrEqual(3);
      }
      expect(
        await region.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  });
}

test("Git 变更树在双主题与三档字号下保留当前文件、展开状态和键盘焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const review = await context.newPage();
  await review.setViewportSize({ width: 590, height: 860 });
  await review.goto(
    "/tests/visual/uiScaleFixture.html?git-navigation&secondary",
  );
  const tree = review.getByRole("complementary", { name: "Git 文件导航" });
  const folder = tree.getByRole("button", { name: "src", exact: true });
  const leaf = tree.getByRole("button", { name: /^定位 src\// });
  const folderGlyph = folder.locator("svg");
  await expect(folderGlyph).toHaveCount(1);
  const closedDrawing = await folderGlyph.locator("path").getAttribute("d");
  await folder.press("Enter");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(folderGlyph.locator("path")).not.toHaveAttribute(
    "d",
    closedDrawing!,
  );
  await expect(leaf.locator("svg")).toHaveCount(1);
  await folder.press("Tab");
  await expect(leaf).toBeFocused();
  await review.keyboard.press("Enter");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(leaf).toHaveAttribute("aria-current", "true");
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    expect((await folderGlyph.boundingBox())!.width).toBeCloseTo(
      (16 * px) / 14,
      1,
    );
    await expect(leaf).toHaveCSS("font-size", px - 2 + "px");
    await expect
      .poll(async () => color(leaf, "background-color"))
      .toEqual(await color(leaf, "--color-selected"));
    expect(await tree.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await expect(leaf).toBeFocused();
    await expect(leaf).not.toHaveCSS("box-shadow", "none");
  }
});

const appearanceSteps = [
  ["暖白", 12],
  ["暗夜", 20],
  ["暖白", 14],
] as const;

async function selectAppearance(settings: Page, theme: string, size: number) {
  await settings.getByRole("button", { name: theme, exact: true }).click();
  const font = settings.getByRole("spinbutton", { name: "界面字号" });
  await font.fill(String(size));
  await font.press("Enter");
}

test("业务列表的项目入口可随外观更新，并可用键盘退出和启动", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const projects = await context.newPage();
  await projects.setViewportSize({ width: 288, height: 620 });
  await projects.goto("/tests/visual/treeMotionFixture.html?sessions");
  const opener = projects
    .getByRole("group")
    .getByRole("button", { name: "新建会话", exact: true });
  await opener.press("Enter");
  const panel = projects.getByLabel("新建会话面板");
  const startTab = panel.getByRole("tab", { name: "新建会话" });
  await expect(startTab).toBeFocused();
  await startTab.press("Tab");
  const entry = panel.getByRole("button", { name: /^design-workbench/ });
  await expect(entry).toBeFocused();
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(entry.getByText("design-workbench")).toHaveCSS(
      "font-size",
      size + "px",
    );
    await expect(entry).not.toHaveCSS("box-shadow", "none");
    await expect(entry).toBeFocused();
    expect(await panel.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      288,
    );
  }
  await entry.press("Escape");
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await entry.press("Enter");
  await expect(panel).toBeHidden();
  await expect(projects.locator("html")).toHaveAttribute(
    "data-started-project",
    "D:/desktop/design-workbench",
  );
});

test("业务列表的定时任务与技能保留选择、焦点和各自的打开操作", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const collections = await context.newPage();
  await collections.setViewportSize({ width: 320, height: 770 });
  await collections.goto(
    "/tests/visual/sidebarTypographyFixture.html?collections",
  );
  const tasks = collections.getByRole("region", { name: "定时任务列表" });
  const task = tasks.getByRole("button", {
    name: "校验发布产物和回滚预案 已暂停",
  });
  await task.press("Enter");
  await expect(task).toHaveAttribute("aria-current", "true");
  const nav = collections.getByRole("navigation", { name: "插件管理" });
  const skills = nav.getByRole("button", { name: "技能", exact: true });
  const mcp = nav.getByRole("button", { name: "MCP", exact: true });
  await expect(skills).toHaveAttribute("aria-current", "page");
  const title = "发布准备和回滚预案的完整审查";
  const card = collections.getByRole("article", { name: title });
  const detail = card.getByRole("button", { name: `查看 ${title} 详情` });
  const longDescription = card.getByText(/^审查发布准备/);
  const shortCard = collections.getByRole("article", { name: "旧版发布检查" });
  const skillHeader = collections
    .getByRole("heading", { name: "技能", exact: true })
    .locator("xpath=ancestor::header");
  const skillAction = skillHeader.getByRole("button", { name: "导入技能" });
  const skillTrack = card.getByRole("switch").locator("+ span");
  await expect(longDescription).toBeVisible();
  const clipping = longDescription.locator("..");
  await expect(clipping).toHaveCSS("white-space", "nowrap");
  await expect(clipping).toHaveCSS("overflow", "hidden");
  const descriptionBounds = (await clipping.boundingBox())!;
  expect(descriptionBounds.height).toBeLessThan(24);
  expect((await longDescription.boundingBox())!.width).toBeGreaterThan(
    descriptionBounds.width,
  );
  expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(256);
  expect((await card.boundingBox())!.height).toBeCloseTo(
    (await shortCard.boundingBox())!.height,
    1,
  );
  const beforeHover = (await longDescription.boundingBox())!.x;
  await card.hover();
  await expect
    .poll(async () => (await longDescription.boundingBox())!.x)
    .toBeLessThan(beforeHover - 2);
  await nav.hover();
  await expect
    .poll(async () => (await longDescription.boundingBox())!.x)
    .toBeCloseTo(beforeHover, 1);
  await expect(card.getByText("项目技能 · 6.8 KiB")).toBeVisible();
  await detail.press("Shift");
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(task.getByText("校验发布产物和回滚预案")).toHaveCSS(
      "font-size",
      size + "px",
    );
    await expect(task).toHaveAttribute("aria-current", "true");
    await expect(skills).toHaveAttribute("aria-current", "page");
    const glyphs = await nav.locator("button > svg").evaluateAll((icons) =>
      icons.map((element) => {
        const icon = element as SVGSVGElement;
        const box = icon.getBBox();
        const rect = icon.getBoundingClientRect();
        const { width, height } = icon.viewBox.baseVal;
        return {
          left: rect.left,
          width: rect.width,
          height: rect.height,
          drawnWidth: (box.width / width) * rect.width,
          drawnHeight: (box.height / height) * rect.height,
          centerX: (box.x + box.width / 2) / width,
          centerY: (box.y + box.height / 2) / height,
        };
      }),
    );
    expect(glyphs).toHaveLength(2);
    const [skillGlyph, mcpGlyph] = glyphs;
    expect(skillGlyph!.left).toBeCloseTo(mcpGlyph!.left, 1);
    for (const glyph of glyphs) {
      expect(glyph.width).toBeCloseTo((16 * size) / 14, 1);
      expect(glyph.height).toBeCloseTo(glyph.width, 1);
      expect(glyph.centerX).toBeCloseTo(0.5, 1);
      expect(glyph.centerY).toBeCloseTo(0.5, 1);
    }
    expect(
      mcpGlyph!.drawnWidth / skillGlyph!.drawnWidth,
    ).toBeGreaterThanOrEqual(0.94);
    expect(mcpGlyph!.drawnWidth / skillGlyph!.drawnWidth).toBeLessThanOrEqual(
      1.06,
    );
    expect(
      Math.abs(skillGlyph!.drawnHeight - mcpGlyph!.drawnHeight),
    ).toBeLessThan(0.75);
    await expect(detail.getByText(title)).toHaveCSS("font-size", size + "px");
    await expect(detail).toBeFocused();
    await expect(detail).not.toHaveCSS("box-shadow", "none");
    const bounds = (await card.boundingBox())!;
    const actions = (await card
      .getByRole("button", { name: `${title} 更多操作` })
      .boundingBox())!;
    expect((await detail.boundingBox())!.width).toBeGreaterThan(140);
    expect(actions.x + actions.width).toBeLessThanOrEqual(
      bounds.x + bounds.width,
    );
  }
  await detail.press("Enter");
  const dialog = collections.getByRole("dialog", { name: "技能详情" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭技能详情" }).click();
  await expect(detail).toBeFocused();
  await collections.getByRole("combobox", { name: "技能状态" }).click();
  await collections.getByRole("option", { name: "已停用" }).click();
  await expect(
    collections.getByRole("switch", { name: "旧版发布检查 启用" }),
  ).toBeVisible();
  await collections.getByRole("combobox", { name: "技能状态" }).click();
  await collections.getByRole("option", { name: "全部状态" }).click();
  const skillHeaderStyle = await skillHeader.evaluate((header) => {
    const style = getComputedStyle(header);
    return [
      style.paddingInlineStart,
      style.paddingBlockStart,
      style.borderBottomWidth,
    ];
  });
  const skillActionHeight = (await skillAction.boundingBox())!.height;
  const skillSwitchStyle = await skillTrack.evaluate((track) => {
    const style = getComputedStyle(track);
    return [style.width, style.height, style.backgroundColor];
  });
  await mcp.click();
  await expect(mcp).toHaveAttribute("aria-current", "page");
  const mcpCard = collections.getByRole("article", { name: "发布服务" });
  const browser = collections.getByRole("article", { name: "AAW 内置浏览器" });
  await expect(browser.getByRole("switch")).toBeEnabled();
  const mcpHeader = collections
    .getByRole("heading", { name: "MCP", exact: true })
    .locator("xpath=ancestor::header");
  expect(
    await mcpHeader.evaluate((header) => {
      const style = getComputedStyle(header);
      return [
        style.paddingInlineStart,
        style.paddingBlockStart,
        style.borderBottomWidth,
      ];
    }),
  ).toEqual(skillHeaderStyle);
  const mcpAction = mcpHeader.getByRole("button", { name: "新增 MCP" });
  expect((await mcpAction.boundingBox())!.height).toBeCloseTo(
    skillActionHeight,
    1,
  );
  expect(
    await browser
      .getByRole("switch")
      .locator("+ span")
      .evaluate((track) => {
        const style = getComputedStyle(track);
        return [style.width, style.height, style.backgroundColor];
      }),
  ).toEqual(skillSwitchStyle);
  await expect(
    browser.getByRole("button", { name: "AAW 内置浏览器", exact: true }),
  ).toBeVisible();
  const plugPath = await mcp.locator("svg path").getAttribute("d");
  expect(plugPath).toBeTruthy();
  await expect(browser.locator("svg path")).toHaveAttribute("d", plugPath!);
  await expect(
    mcpCard
      .getByRole("button", { name: "发布服务", exact: true })
      .locator("svg path"),
  ).toHaveAttribute("d", plugPath!);
  await mcpCard.getByRole("button", { name: "发布服务", exact: true }).click();
  const serviceDetails = collections.getByRole("complementary", {
    name: "发布服务 详情",
  });
  await expect(serviceDetails).toBeVisible();
  await expect(mcpCard).toBeHidden();
  await serviceDetails.getByRole("tab", { name: "连接配置" }).click();
  await expect(
    serviceDetails.getByText("http://localhost:9000/mcp"),
  ).toBeVisible();
  await serviceDetails.getByRole("button", { name: "返回服务列表" }).click();
  await expect(mcpCard).toBeVisible();
  await collections.setViewportSize({ width: 1400, height: 900 });
  await mcpCard.getByRole("button", { name: "发布服务", exact: true }).click();
  await expect(serviceDetails).toBeVisible();
  await expect(mcpCard).toBeVisible();
  const rowBounds = (await mcpCard.boundingBox())!;
  expect((await serviceDetails.boundingBox())!.x).toBeGreaterThan(
    rowBounds.x + rowBounds.width,
  );
});

test("MCP 导入按钮和表单按钮共用尺寸，窄窗下文字保留内边距", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 670 });
  await page.goto("/tests/visual/sidebarTypographyFixture.html?collections");
  await page
    .getByRole("navigation", { name: "插件管理" })
    .getByRole("button", { name: "MCP", exact: true })
    .click();
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新增 MCP" });
  const preview = dialog.getByRole("button", { name: "预览导入" });
  const cancel = dialog.getByRole("button", { name: "取消" });
  await expect(preview).toBeDisabled();
  await dialog.getByRole("tab", { name: "表单配置" }).click();

  const properties = [
    "font-size",
    "min-height",
    "padding-inline-start",
    "padding-inline-end",
  ] as const;
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  const formStyle = await save.evaluate((button, props) => {
    const style = getComputedStyle(button);
    return props.map((prop) => style.getPropertyValue(prop));
  }, properties);
  expect(parseFloat(formStyle[2]!)).toBeGreaterThan(0);

  await dialog.getByRole("tab", { name: "JSON 导入" }).click();
  await dialog.getByRole("button", { name: "填入示例" }).click();
  await expect(preview).toBeEnabled();
  for (const button of [cancel, preview]) {
    for (const [index, property] of properties.entries()) {
      await expect(button).toHaveCSS(property, formStyle[index]!);
    }
    await expect(button).toBeInViewport();
  }
});

test("技能详情宽屏并列大纲与技能信息，窄屏仍可浏览真实文件区域", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const skills = await context.newPage();
  await skills.setViewportSize({ width: 1360, height: 900 });
  await skills.goto("/tests/visual/sidebarTypographyFixture.html?collections");
  const title = "发布准备和回滚预案的完整审查";
  const opener = skills.getByRole("button", { name: `查看 ${title} 详情` });
  await opener.press("Enter");
  const detail = skills.getByRole("dialog", { name: "技能详情" });
  const info = detail.getByRole("complementary", { name: "技能信息" });
  const outline = detail.getByRole("navigation", { name: "文档目录" });
  const section = outline.getByRole("button", { name: "验收记录" });
  const original = detail.getByRole("button", { name: "原文", exact: true });
  const copy = detail.getByRole("button", { name: "复制 SKILL.md" });
  await expect(info).toBeVisible();
  await expect(outline).toBeVisible();
  await expect(copy).toBeVisible();
  await expect(copy).toHaveCSS("border-top-width", "1px");
  await expect(copy.locator("svg")).toHaveCount(1);
  const heading = detail.getByRole("heading", { name: title });
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(heading).toHaveCSS("font-size", size + 16 + "px");
    await expect(info).toBeVisible();
    await expect(section).toBeVisible();
  }
  await section.click();
  await expect(section).toHaveAttribute("aria-current", "location");
  await expect(
    detail.getByRole("heading", { name: "验收记录" }),
  ).toBeInViewport();
  await original.click();
  await expect(
    detail.getByRole("region", { name: "SKILL.md 原文" }),
  ).toContainText("name: release-review");
  await expect(outline).toBeHidden();

  await skills.setViewportSize({ width: 390, height: 760 });
  await expect(info).toBeHidden();
  const inspectorToggle = detail.getByRole("button", {
    name: "技能信息与文件",
  });
  await inspectorToggle.press("Enter");
  await expect(info).toBeVisible();
  await info.getByRole("button", { name: /mcp.json/ }).press("Enter");
  await expect(info).toBeHidden();
  await expect(inspectorToggle).toBeFocused();
  await expect(
    detail.getByRole("region", { name: "mcp.json 原文" }),
  ).toContainText('"server":"workspace"');
  await expect(detail.getByRole("button", { name: "复制原文" })).toBeVisible();
  await expect(
    detail.getByRole("group", { name: "文档显示方式" }),
  ).toBeHidden();
  await skills.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(opener).toBeFocused();
});

test("业务列表的工作流卡在窄栏放得下确认按钮，并保留焦点和打开操作", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflows = await context.newPage();
  await workflows.setViewportSize({ width: 288, height: 630 });
  await workflows.goto("/tests/visual/workflowFixture.html?library&appearance");
  const tab = workflows.getByRole("tab", { name: "我的 1" });
  await workflows.getByRole("tab", { name: /^预置/ }).press("ArrowRight");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const collection = workflows.getByRole("region", { name: "我的工作流" });
  const name = "发布准备、兼容性审查和回滚演练";
  const card = collection.getByRole("button", { name: `查看工作流 ${name}` });
  const remove = collection.getByRole("button", { name: "删除工作流" });
  await remove.press("Enter");
  const confirm = collection.getByRole("button", { name: "确认删除工作流" });
  await expect(confirm).toBeFocused();
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(card.getByText(name)).toHaveCSS("font-size", size + "px");
    await expect(confirm).toBeFocused();
    await expect(confirm).not.toHaveCSS("box-shadow", "none");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const main = (await card.boundingBox())!;
    const action = (await confirm.boundingBox())!;
    expect(main.x + main.width).toBeLessThanOrEqual(action.x);
    expect(
      await collection.evaluate((el) => el.scrollWidth),
    ).toBeLessThanOrEqual(288);
  }
  await confirm.press("Escape");
  await expect(remove).toBeFocused();
  await card.press("Enter");
  await expect(workflows.locator("html")).toHaveAttribute(
    "data-opened-workflow",
    "release-review",
  );
});

test("工作流文件列表和侧栏保留外观切换前状态，删除附件后焦点移动", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflows = await context.newPage();
  await workflows.setViewportSize({ width: 320, height: 740 });
  await workflows.goto("/tests/visual/workflowFixture.html?files&appearance");
  const sidebar = workflows.getByRole("region", { name: "工作流列表" });
  const runTab = sidebar.getByRole("tab", { name: "运行" });
  await sidebar.getByRole("tab", { name: "预置" }).press("End");
  await expect(runTab).toBeFocused();
  await expect(runTab).toHaveAttribute("aria-selected", "true");
  const run = sidebar.getByRole("button", { name: /核对发布准备和回滚预案/ });
  await run.press("Enter");
  await expect(workflows.locator("html")).toHaveAttribute(
    "data-opened-run",
    "release",
  );
  await workflows.getByText("附件与标题（可选）", { exact: true }).click();
  const files = workflows.getByRole("group", { name: "附件", exact: true });
  await files.getByRole("button", { name: "选择文件…" }).click();
  const first = files.getByRole("button", { name: /移除 .*详细交接说明/ });
  const second = files.getByRole("button", { name: /移除 .*回滚预案/ });
  const input = files.getByRole("textbox", { name: "附件路径" });
  await input.fill("docs/尚未添加的检查记录.md");
  await first.press("Shift");
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(first).toBeFocused();
    await expect(first).not.toHaveCSS("box-shadow", "none");
    await expect(files.getByText(/详细交接说明/)).toHaveCSS(
      "font-size",
      size - 2 + "px",
    );
    await expect(input).toHaveValue("docs/尚未添加的检查记录.md");
    await expect(runTab).toHaveAttribute("aria-selected", "true");
    expect(await files.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
  await first.press("Enter");
  await expect(first).toBeHidden();
  await expect(second).toBeFocused();
  await second.press("Enter");
  await expect(second).toBeHidden();
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(
    files.getByRole("button", { name: /移除 .*尚未添加的检查记录/ }),
  ).toBeVisible();
});

test("任务、会话状态和差异行随外观更新，保留折叠、阅读位置和焦点", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const detail = await context.newPage();
  await detail.setViewportSize({ width: 320, height: 800 });
  await detail.goto(
    "/tests/visual/sessionStatusOverlayFixture.html?row-audit&appearance",
  );
  const diffButton = detail.getByRole("button", { name: /修改片段/ });
  await diffButton.press("Enter");
  const diff = detail.getByLabel("行级差异");
  await diff.evaluate((element) => {
    element.scrollTop = 70;
  });
  const firstVisibleRow = () =>
    diff.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      return [...(element.firstElementChild?.children ?? [])].find(
        (child) => child.getBoundingClientRect().bottom > top + 1,
      )?.textContent;
    });
  const readingPosition = await firstVisibleRow();
  const agent = detail.getByRole("button", { name: /Review.*核对部署步骤/ });
  await agent.press("Enter");
  await expect(agent).not.toHaveCSS("box-shadow", "none");
  await expect(detail.getByText("已核对回滚记录。")).toBeVisible();
  const hidden = detail.getByRole("button", { name: /已完成 3 项/ });
  await hidden.press("Shift");
  const popup = detail.getByLabel("隐藏任务步骤");
  const row = popup.getByText("核对发布事项 1", { exact: true });
  await expect(row).toBeVisible();
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(row).toHaveCSS("font-size", size - 2 + "px");
    await expect(detail.getByText(/1 条排队待发/)).toHaveCSS(
      "font-size",
      size - 2 + "px",
    );
    await expect(diff).toHaveCSS("font-size", size - 4 + "px");
    for (const kind of ["added", "removed"]) {
      const diffRow = diff.locator(`.bg-diff-${kind}-row`).first();
      const number = diffRow.locator(`.bg-diff-${kind}-gutter`).first();
      const background = blend(
        await color(diffRow, "background-color"),
        await color(diff, "background-color"),
      );
      expect(
        ratio(await color(diffRow, "color"), background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        ratio(
          await color(number, "color"),
          await color(number, "background-color"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
    const connection = detail
      .getByRole("region", { name: "项目状态" })
      .getByText(/正在连接 agent/);
    await expect(connection).toHaveCSS("font-size", size - 2 + "px");
    await expect(hidden).toBeFocused();
    await expect(hidden).not.toHaveCSS("box-shadow", "none");
    await expect(hidden).toHaveAttribute("aria-expanded", "true");
    await expect(agent).toHaveAttribute("aria-expanded", "true");
    expect(await firstVisibleRow()).toBe(readingPosition);
    const background = await color(popup, "--color-menu");
    expect(ratio(await color(row, "color"), background)).toBeGreaterThanOrEqual(
      4.5,
    );
  }
  await hidden.press("Escape");
  await expect(popup).toBeHidden();
  await expect(hidden).toBeFocused();
});

test("存储数据行、用量记录和 Markdown 表格在大字号下保持可读与可操作", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const details = await context.newPage();
  await details.setViewportSize({ width: 320, height: 800 });
  await details.goto(
    "/tests/visual/sessionStatusOverlayFixture.html?row-audit&appearance",
  );
  const storage = details.getByRole("region", { name: "Desktop 存储" });
  const diagnostics = storage.getByRole("button", {
    name: "诊断日志",
    exact: true,
  });
  await diagnostics.press("Enter");
  const selected = storage.getByRole("checkbox", { name: /^选择/ }).first();
  await selected.press("Space");
  await expect(selected).toBeFocused();
  const checkmark = selected.locator("+ span");
  await expect(checkmark).not.toHaveCSS("box-shadow", "none");
  const table = details.getByRole("region", { name: "表格横向滚动" });
  await table.evaluate((el) => {
    el.scrollLeft = 90;
  });
  const shadows = table.locator("..").locator(":scope > [aria-hidden='true']");
  await expect(shadows).toHaveCount(2);
  await expect(shadows.first()).not.toHaveCSS("box-shadow", "none");
  await table.press("Shift");
  const monthly = details.getByRole("region", { name: "示例额度" });
  const progress = monthly.getByRole("progressbar", {
    name: "月度已用 Credit",
  });
  for (const [theme, size] of appearanceSteps) {
    await selectAppearance(page, theme, size);
    await expect(diagnostics).toHaveCSS("font-size", size - 2 + "px");
    await expect(diagnostics).toHaveAttribute("aria-expanded", "true");
    await expect(selected).toBeChecked();
    expect((await checkmark.boundingBox())!.width).toBeCloseTo(
      (16 * size) / 14,
      1,
    );
    await expect(monthly.getByText("月度", { exact: true })).toHaveCSS(
      "font-size",
      size - 2 + "px",
    );
    await expect(progress).toHaveAttribute("aria-valuetext", "6.4%");
    await expect(table).toBeFocused();
    await expect(table).not.toHaveCSS("box-shadow", "none");
    await expect(shadows).toHaveCount(2);
    expect(await table.evaluate((el) => el.scrollLeft)).toBe(90);
    await expect(table.getByRole("table")).toHaveCSS("font-size", size + "px");
  }
  await table.press("ArrowRight");
  await expect
    .poll(() => table.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(90);
});
