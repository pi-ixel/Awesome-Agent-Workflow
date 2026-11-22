import { expect, test, type Locator, type Page } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

async function dragDivider(page: Page, divider: Locator, delta: number) {
  const guide = divider.locator("[aria-hidden]");
  await page.mouse.move(0, 0);
  await expect(guide).toHaveCSS("opacity", "0");
  await divider.hover();
  await expect(guide).toHaveCSS("opacity", "1");
  const bounds = (await divider.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 4 });
  await expect(divider).toHaveAttribute("data-resizing", "true");
  await expect(guide).toHaveCSS("opacity", "1");
  await page.mouse.up();
  await expect(divider).not.toHaveAttribute("data-resizing", "true");
}

test("右栏、文件树和大纲共享分隔条，拖动与键盘调整保留当前内容", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 1800, height: 800 });
  await workspace.emulateMedia({ reducedMotion: "reduce" });
  await workspace.goto("/tests/visual/layoutMotionFixture.html?appearance");
  await workspace.getByRole("button", { name: "打开文件栏" }).click();
  const panel = workspace.getByRole("complementary", { name: "项目右侧工具栏" });
  const right = workspace.getByRole("separator", { name: "调整右栏宽度" });
  const initial = Number(await right.getAttribute("aria-valuenow"));
  await expect(panel).toHaveCSS("width", initial + "px");
  await dragDivider(workspace, right, -48);
  await expect(right).toHaveAttribute("aria-valuenow", String(initial + 48));
  await expect(panel).toHaveCSS("width", initial + 48 + "px");
  await right.dblclick();
  await expect(right).toHaveAttribute("aria-valuenow", String(initial));
  await right.press("End");
  await expect(right).toHaveAttribute("aria-valuenow", (await right.getAttribute("aria-valuemax"))!);

  await workspace.getByRole("treeitem", { name: "README.md" }).click();
  const tree = workspace.getByRole("separator", { name: "调整目录列宽度" });
  const treeWidth = Number(await tree.getAttribute("aria-valuenow"));
  await dragDivider(workspace, tree, -24);
  await expect(tree).toHaveAttribute("aria-valuenow", String(treeWidth + 24));
  const treeRatio = () => tree.evaluate((el) =>
    (el.previousElementSibling?.clientWidth ?? 0) / el.parentElement!.clientWidth,
  );
  const savedRatio = await treeRatio();
  await workspace.setViewportSize({ width: 1500, height: 800 });
  await expect.poll(async () => Number(await tree.getAttribute("aria-valuenow"))).toBeLessThan(treeWidth + 24);
  expect(await treeRatio()).toBeCloseTo(savedRatio, 2);
  await workspace.setViewportSize({ width: 1800, height: 800 });
  await tree.dblclick();
  await expect(tree).toHaveAttribute("aria-valuenow", String(treeWidth));
  await workspace.getByRole("button", { name: "收起目录" }).click();
  await expect(tree).toHaveCount(0);

  await workspace.getByRole("button", { name: "大纲", exact: true }).click();
  const outline = workspace.getByRole("separator", { name: "调整大纲宽度" });
  const defaultOutline = Number(await outline.getAttribute("aria-valuenow"));
  await dragDivider(workspace, outline, 32);
  const selectedWidth = String(defaultOutline + 32);
  await expect(outline).toHaveAttribute("aria-valuenow", selectedWidth);
  await expect.poll(() => workspace.evaluate(() => localStorage.getItem("aaw:document-outline-width"))).toBe(selectedWidth);
  await outline.press("Shift");
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(workspace.locator("html")).toHaveCSS("--ui-font-size", px + "px");
    await expect(outline).toBeFocused();
    await expect(outline).toHaveAttribute("aria-valuenow", selectedWidth);
    const guide = outline.locator("[aria-hidden]");
    await expect(guide).toHaveCSS("opacity", "1");
    expect(ratio(await color(guide, "background-color"), await color(outline, "--color-base"))).toBeGreaterThanOrEqual(3);
    await expect.poll(() => color(outline, "background-color")).toEqual(await color(outline, "--color-line"));
  }
  await outline.press("Home");
  await expect(outline).toHaveAttribute("aria-valuenow", (await outline.getAttribute("aria-valuemin"))!);
  await outline.dblclick();
  await expect(outline).toHaveAttribute("aria-valuenow", String(defaultOutline));
  const wideMax = Number(await outline.getAttribute("aria-valuemax"));
  await workspace.setViewportSize({ width: 1300, height: 800 });
  await expect.poll(async () => Number(await outline.getAttribute("aria-valuemax"))).toBeLessThan(wideMax);
  await expect(outline).toHaveAttribute("aria-valuenow", String(defaultOutline));
  await expect(workspace.getByRole("heading", { name: "文件视图示例" })).toBeVisible();
});

test("右栏遮罩与完整视图对话入口随外观更新，键盘操作保留草稿", async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 580, height: 780 });
  await workspace.emulateMedia({ reducedMotion: "reduce" });
  await workspace.goto("/tests/visual/layoutMotionFixture.html?appearance");
  const draft = workspace.getByRole("textbox", { name: "草稿" });
  const open = workspace.getByRole("button", { name: "打开文件栏" });
  await draft.fill("发布前核对清单");
  await open.press("Enter");
  const scrim = workspace.getByRole("button", { name: "关闭右栏遮罩" });
  await scrim.press("Shift");
  for (const theme of ["暖白", "暗夜", "暖白"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await expect(scrim).toBeFocused();
    await expect(scrim).not.toHaveCSS("box-shadow", "none");
    await expect.poll(() => color(scrim, "background-color")).toEqual(await color(scrim, "--color-scrim"));
    await expect(draft).toHaveValue("发布前核对清单");
  }
  await scrim.press("Enter");
  await expect(scrim).toBeHidden();
  await expect(open).toBeFocused();

  await workspace.setViewportSize({ width: 1500, height: 780 });
  await open.press("Enter");
  await workspace.getByRole("button", { name: "进入完整视图" }).press("Enter");
  const conversation = workspace.getByTestId("full-view-conversation-tab");
  await conversation.press("Shift");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暗夜", 12], ["暖白", 20], ["暗夜", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(conversation).toBeFocused();
    await expect(conversation).toHaveCSS("font-size", `${px}px`);
    await expect(conversation).not.toHaveCSS("box-shadow", "none");
  }
  await conversation.press("Enter");
  await expect(conversation).toHaveAttribute("aria-current", "page");
  await expect(draft).toHaveValue("发布前核对清单");
});

test("新标签页入口在窄栏换肤时保留焦点和完整标签，仍可键盘打开", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 277, height: 620 });
  await workspace.goto(
    "/tests/visual/layoutMotionFixture.html?appearance&new-tab",
  );
  const panel = workspace.getByRole("complementary", {
    name: "项目右侧工具栏",
  });
  const file = panel.getByRole("button", { name: "文件 从目录中选择一个文件" });
  await expect(file.locator("svg path")).toHaveAttribute("d", /^m6 14/);
  const title = file.getByText("文件", { exact: true });
  const description = file.getByText("从目录中选择一个文件", { exact: true });
  await file.press("Tab");
  await workspace.keyboard.press("Shift+Tab");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(title).toHaveCSS("font-size", `${px}px`);
    await expect(file).toBeFocused();
    await expect(file).not.toHaveCSS("box-shadow", "none");
    const surface = await color(file, "--color-base");
    expect(ratio(await color(title, "color"), surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      ratio(await color(description, "color"), surface),
    ).toBeGreaterThanOrEqual(4.5);
    const icon = await file
      .locator("svg")
      .evaluate((el) => parseFloat(getComputedStyle(el).width));
    expect(icon).toBeCloseTo((24 * px) / 14, 1);
    for (const locator of [file, title, description, panel])
      expect(
        await locator.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
  }
  await file.press("Enter");
  await expect(panel.getByRole("tab", { name: /^文件/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    panel.getByRole("treeitem", { name: "README.md" }),
  ).toBeVisible();
});

test("溢出的页签可键盘访问，总览随换肤和窗口缩放保留搜索", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 490, height: 600 });
  await workspace.goto(
    "/tests/visual/layoutMotionFixture.html?appearance&overflow-tabs",
  );
  const list = workspace.getByRole("tablist", { name: "内容标签" });
  const viewport = workspace.locator("[data-side-pane-tabs-viewport]");
  const tabs = list.getByRole("tab");
  await expect(tabs).toHaveCount(12);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await tabs.last().press("Home");
  await expect(tabs.first()).toBeFocused();
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(0);
  await tabs.first().press("End");
  await expect(tabs.last()).toBeFocused();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const trigger = workspace.getByRole("button", {
    name: "搜索标签页",
    exact: true,
  });
  await trigger.press("Enter");
  const overview = workspace.getByRole("dialog", { name: "搜索标签页" });
  const search = overview.getByRole("textbox", { name: "查找标签页" });
  const query = "交接记录-02";
  await expect(search).toBeFocused();
  await search.fill(query);
  await search.press("Home");
  await search.press("Shift+ArrowRight");

  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 20],
    ["暗夜", 12],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workspace.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(search).toBeFocused();
    await expect(search).toHaveValue(query);
    expect(
      await search.evaluate((el: HTMLInputElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, 1]);
  }
  await workspace.setViewportSize({ width: 277, height: 460 });
  await expect
    .poll(() =>
      overview.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= 7.5 &&
          rect.right <= window.innerWidth - 7.5 &&
          rect.top >= 7.5 &&
          rect.bottom <= window.innerHeight - 7.5
        );
      }),
    )
    .toBe(true);
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  const entry = overview.getByRole("button", { name: /^交接记录-02/ });
  await expect(entry).toBeFocused();
  await entry.press("Enter");
  await expect(overview).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(list.getByRole("tab", { name: /交接记录-02/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await trigger.press("Enter");
  await search.fill(query);
  await search.press("Tab");
  await expect(entry).toBeFocused();
  await entry.press("Tab");
  const close = overview.getByRole("button", { name: /^关闭 交接记录-02/ });
  await expect(close).toBeFocused();
  await close.press("Space");
  await expect(overview.getByText("最近关闭的标签页")).toBeVisible();
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await entry.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(list.getByRole("tab", { name: /交接记录-02/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("长文件面包屑换肤和改字号时保留当前路径与键盘可见段", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 570, height: 660 });
  await workspace.goto(
    "/tests/visual/layoutMotionFixture.html?appearance&deep-path",
  );
  await workspace.getByRole("button", { name: "打开文件栏" }).click();
  for (const directory of [
    "docs",
    "平台治理与升级说明",
    "客户端开发交接",
    "双主题外观验证",
    "其他演练记录",
  ]) {
    await workspace
      .getByRole("treeitem", { name: directory, exact: true })
      .click();
  }
  await workspace
    .getByRole("treeitem", { name: "README.md", exact: true })
    .click();
  const path = workspace.getByRole("navigation", { name: "文件路径" });
  const file = path.locator('[aria-current="page"]');
  await expect(file).toHaveText("README.md");
  await expect
    .poll(() => path.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const section = path.getByRole("button", { name: "客户端开发交接" });
  const prior = path.getByRole("button", { name: "平台治理与升级说明" });
  await prior.press("Tab");
  await expect(section).toBeFocused();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workspace.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(file).toHaveText("README.md");
    await expect(section).toBeFocused();
    await expect(section).not.toHaveCSS("box-shadow", "none");
    await expect(section).toHaveAttribute("data-hint", "客户端开发交接");
    await expect
      .poll(() =>
        section.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const frame = el.closest("nav")!.getBoundingClientRect();
          return rect.left >= frame.left + 7 && rect.right <= frame.right - 7;
        }),
      )
      .toBe(true);
  }
  await section.press("Enter");
  const destination = workspace.getByRole("treeitem", {
    name: "客户端开发交接",
    exact: true,
  });
  await expect(destination).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => color(destination, "background-color"))
    .toEqual(await color(destination, "--color-selected"));
  await expect(file).toHaveText("README.md");
});

test("键盘关闭标签后，焦点移动到相邻标签或新增入口", async ({ page }) => {
  await page.goto("/tests/visual/layoutMotionFixture.html?draggable-tabs");
  const list = page.getByRole("tablist", { name: "内容标签" });
  const first = list.getByRole("tab", { name: "第一份.md" });
  const second = list.getByRole("tab", { name: "第二份.md" });
  const third = list.getByRole("tab", { name: "第三份.md" });

  await expect(third).toHaveAttribute("aria-selected", "true");
  await third.press("Home");
  await expect(first).toBeFocused();
  const close = list.getByRole("button", { name: "关闭 第一份.md" });
  await first.press("Tab");
  await expect(close).toBeFocused();
  await expect(close).not.toHaveCSS("box-shadow", "none");
  await close.press("Enter");
  await expect(first).toHaveCount(0);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(second).toBeFocused();

  await second.press("End");
  await expect(third).toBeFocused();
  await third.press("Delete");
  await expect(third).toHaveCount(0);
  await expect(second).toBeFocused();
  await second.press("Delete");
  const add = page.getByRole("button", { name: "新增标签" });
  await expect(list.getByRole("tab")).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect(add).not.toHaveCSS("box-shadow", "none");
});

test("页签拖动期间可换肤，落位保留激活页且方向键按新顺序切换", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  await page.getByRole("button", { name: "暖白", exact: true }).click();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await font.fill("20");
  await font.press("Enter");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 1560, height: 800 });
  await workspace.goto(
    "/tests/visual/layoutMotionFixture.html?appearance&draggable-tabs",
  );
  const list = workspace.getByRole("tablist", { name: "内容标签" });
  const first = list.getByRole("tab", { name: "第一份.md" });
  const second = list.getByRole("tab", { name: "第二份.md" });
  const third = list.getByRole("tab", { name: "第三份.md" });
  await expect(third).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveCSS("font-size", "20px");
  const start = (await first.boundingBox())!;
  const destination = (await second.boundingBox())!;
  await workspace.mouse.move(
    start.x + start.width / 2,
    start.y + start.height / 2,
  );
  await workspace.mouse.down();
  try {
    await workspace.mouse.move(
      destination.x + destination.width / 2 + 4,
      start.y + start.height / 2,
      { steps: 8 },
    );
    await expect(first).not.toHaveCSS("transform", "none");
    await page
      .getByRole("button", { name: "暗夜", exact: true })
      .evaluate((button: HTMLElement) => button.click());
    await expect(workspace.locator("html")).not.toHaveClass(/theme-warm/);
    await expect(first).not.toHaveCSS("transform", "none");
  } finally {
    await workspace.mouse.up();
  }
  await expect(list.getByRole("tab")).toHaveText([
    "第二份.md",
    "第一份.md",
    "第三份.md",
  ]);
  await expect(third).toHaveAttribute("aria-selected", "true");
  await third.press("ArrowLeft");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).not.toHaveCSS("box-shadow", "none");
  await first.press("Home");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-selected", "true");
});

test("大纲跳转、目录展开和标题焦点在切换主题及字号后保留", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 1500, height: 800 });
  await workspace.goto("/tests/visual/layoutMotionFixture.html?appearance");
  await workspace.getByRole("button", { name: "打开文件栏" }).click();
  await workspace.getByRole("treeitem", { name: "README.md" }).click();
  await workspace.getByRole("button", { name: "大纲", exact: true }).click();
  const outline = workspace.getByRole("navigation", { name: "文件大纲" });
  await outline.getByRole("button", { name: "展开 第一节" }).press("Enter");
  const section = outline.getByRole("button", { name: "小节", exact: true });
  await section.press("Enter");
  await expect(section).toHaveAttribute("aria-current", "location");
  const activeRow = section.locator("..");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(section).toHaveCSS("font-size", px - 2 + "px");
    await expect(section).toBeFocused();
    await expect(section).not.toHaveCSS("box-shadow", "none");
    await expect(section).toHaveAttribute("aria-current", "location");
    await expect
      .poll(() => color(activeRow, "background-color"))
      .toEqual(await color(section, "--color-selected"));
    await expect(
      outline.getByRole("button", { name: "折叠 第一节" }),
    ).toHaveAttribute("aria-expanded", "true");
  }
});

test("Markdown 源码编辑器随主题和字号原位更新，草稿、选区和焦点保留", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 1000, height: 720 });
  await workspace.goto("/tests/visual/layoutMotionFixture.html?appearance");
  await workspace.getByRole("button", { name: "打开文件栏" }).click();
  await workspace.getByRole("treeitem", { name: "README.md" }).click();
  const header = workspace.locator("[data-file-manager-header]");
  await header.getByRole("button", { name: "更多", exact: true }).click();
  await workspace
    .getByRole("menuitemradio", { name: "源码", exact: true })
    .click();
  const editor = workspace.getByRole("textbox", {
    name: "Markdown 源码编辑器",
  });
  const surface = workspace.locator(".cm-editor");
  const cursor = surface.locator(".cm-cursor-primary");
  const fold = workspace.locator(".cm-foldGutter span[data-hint]").first();
  await editor.press("Control+Home");
  await workspace.keyboard.insertText("草稿");
  await editor.press("Shift+ArrowLeft");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(editor).toHaveCSS("font-size", px + "px");
    await expect(editor).toBeFocused();
    await expect(editor).toContainText("草稿");
    expect(await editor.evaluate(() => window.getSelection()?.toString())).toBe(
      "稿",
    );
    const background = await color(surface, "background-color");
    expect(background).toEqual(await color(surface, "--color-base"));
    expect(
      ratio(await color(cursor, "border-left-color"), background),
    ).toBeGreaterThanOrEqual(4.5);
    const width = await fold.evaluate((el) =>
      parseFloat(getComputedStyle(el, "::before").width),
    );
    expect(width).toBeCloseTo((4 * px) / 14, 1);
  }
});

async function widthTransition(locator: Locator, trigger: () => Promise<void>) {
  const before = await locator.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  await trigger();
  const widths = await locator.evaluate(async (node) => {
    const values: number[] = [];
    for (let frame = 0; frame < 18; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      values.push(node.getBoundingClientRect().width);
    }
    return values;
  });
  const after = widths.at(-1)!;
  expect(Math.abs(before - after)).toBeGreaterThan(50);
  expect(
    widths.some(
      (width) =>
        width > Math.min(before, after) + 10 &&
        width < Math.max(before, after) - 10,
    ),
  ).toBe(true);
}

test("layout edges move continuously, with the chat draft preserved through complete view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  const main = page.locator("main");
  const nav = page.getByRole("button", { name: "切换项目栏" });
  const open = page.getByRole("button", { name: "打开文件栏" });
  await expect(page.locator(".session-status-mini")).toBeVisible();
  const statusFades = await nav.evaluate(async (button) => {
    if (button instanceof HTMLElement) button.click();
    const card = document.querySelector(".session-status-panel")!;
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const opacity = Number(getComputedStyle(card).opacity);
      if (opacity > 0 && opacity < 1) return true;
    }
    return false;
  });
  expect(statusFades).toBe(true);
  await expect(page.locator(".session-status-panel")).toBeVisible();
  await expect(page.locator(".session-status-panel")).toHaveCSS("opacity", "1");
  await widthTransition(main, () => nav.click());
  const reservation = page.locator(".workbench-right-reservation");
  await open.click();
  await expect(page.locator("[data-panel-slide]")).toHaveCount(0);
  const preview = page.getByLabel("预览区");
  await widthTransition(preview, () =>
    page.getByRole("button", { name: "收起目录" }).click(),
  );
  await widthTransition(preview, () =>
    page.getByRole("button", { name: "展开目录" }).click(),
  );
  await widthTransition(reservation, () =>
    page.getByRole("button", { name: "进入完整视图" }).click(),
  );
  await expect(page.getByTestId("full-view-host")).toHaveAttribute(
    "data-side-pane-full-view-host",
    "floating",
  );
  await widthTransition(reservation, () =>
    page.getByRole("button", { name: "退出完整视图" }).click(),
  );
  await expect(page.getByRole("textbox", { name: "草稿" })).toHaveValue(
    "保留草稿",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "项目右侧工具栏" }),
  ).toBeHidden();
});

test("narrow panel uses a slide without reserving width, and reduced motion switches immediately", async ({
  page,
}) => {
  await page.setViewportSize({ width: 580, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  const open = page.getByRole("button", { name: "打开文件栏" });
  const pane = page.locator('aside[aria-label="项目右侧工具栏"]');
  await expect(pane).toBeHidden();
  const slide = await open.evaluate((button) => {
    if (button instanceof HTMLElement) button.click();
    return new Promise<boolean>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const pane = document.querySelector(
            'aside[aria-label="项目右侧工具栏"]',
          )!;
          resolve(pane.getBoundingClientRect().right > window.innerWidth + 5);
        }),
      ),
    );
  });
  expect(slide).toBe(true);
  await expect(page.locator(".workbench-right-reservation")).toHaveCSS(
    "width",
    "0px",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Escape");
  await expect(pane).toHaveAttribute("hidden", "");
  await expect(pane).toHaveCSS("transition-duration", "0s");
});

test("the gear focuses the shared tree placement preference and both folder views follow it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  const tree = page.getByRole("tree");
  const row = tree.getByRole("treeitem", { name: "README.md" });
  const preview = page.getByLabel("预览区");
  const gear = page.getByRole("button", { name: "文件树设置" });
  const collapse = page.getByRole("button", { name: "收起目录" });
  await row.click();
  await expect(
    preview.getByRole("heading", { name: "文件视图示例" }),
  ).toBeVisible();
  expect((await tree.boundingBox())!.x).toBeGreaterThan(
    (await preview.boundingBox())!.x,
  );
  expect((await collapse.boundingBox())!.x).toBeGreaterThan(
    (await gear.boundingBox())!.x,
  );
  const separator = page.getByRole("separator", { name: "调整目录列宽度" });
  const leftEdge = (await separator.boundingBox())!.x;
  await separator.press("ArrowLeft");
  await expect
    .poll(async () => (await separator.boundingBox())!.x)
    .toBeLessThan(leftEdge);

  await gear.click();
  const position = page.getByRole("group", { name: "文件树位置" });
  await expect(position.getByRole("button", { name: "右侧" })).toBeFocused();
  await position.getByRole("button", { name: "左侧" }).click();
  await page.keyboard.press("Escape");
  await expect(gear).toBeFocused();
  expect((await tree.boundingBox())!.x).toBeLessThan(
    (await preview.boundingBox())!.x,
  );
  expect((await collapse.boundingBox())!.x).toBeLessThan(
    (await gear.boundingBox())!.x,
  );
  await expect(
    preview.getByRole("heading", { name: "文件视图示例" }),
  ).toBeVisible();
  await widthTransition(preview, () => collapse.click());
  await widthTransition(preview, () =>
    page.getByRole("button", { name: "展开目录" }).click(),
  );

  await page.getByRole("button", { name: "打开目录标签" }).click();
  await expect(tree.getByRole("treeitem", { name: "README.md" })).toBeVisible();
  expect((await tree.boundingBox())!.x).toBeLessThan(
    (await preview.boundingBox())!.x,
  );
  expect((await collapse.boundingBox())!.x).toBeLessThan(
    (await gear.boundingBox())!.x,
  );
});

test("file view options move between the toolbar and the More menu with header width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const views = page.getByRole("group", { name: "文件视图" });
  await expect(views.getByRole("button", { name: "预览" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await views.getByRole("button", { name: "源码" }).press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).toBeVisible();

  const header = page.locator("[data-file-manager-header]");
  await header.evaluate((el) => {
    (el as HTMLElement).style.maxWidth = "300px";
  });
  await expect(views).toHaveCount(0);
  const breadcrumb = page.getByRole("navigation", { name: "文件路径" });
  await expect(breadcrumb).toHaveCSS("scrollbar-width", "none");
  await expect
    .poll(() => breadcrumb.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await breadcrumb.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect.poll(() => breadcrumb.evaluate((el) => el.scrollLeft)).toBe(0);
  await header.getByRole("button", { name: "更多" }).click();
  const more = page.getByRole("menu", { name: "更多" });
  await expect(
    more.getByRole("menuitemradio", { name: "源码" }),
  ).toHaveAttribute("aria-checked", "true");
  await more.getByRole("menuitemradio", { name: "预览" }).click();
  await expect(
    page.getByRole("heading", { name: "文件视图示例" }),
  ).toBeVisible();
  await header.evaluate((el) => {
    (el as HTMLElement).style.maxWidth = "";
  });
  await expect(views.getByRole("button", { name: "预览" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("file find floats above the document and keeps the query when switching to source and back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const title = page.getByRole("heading", { name: "文件视图示例" });
  const originalBox = await title.boundingBox();
  await page.getByRole("button", { name: "搜索文件" }).click();
  const find = page.getByRole("dialog", { name: "文件查找" });
  const query = find.getByRole("textbox", { name: "搜索当前文件" });
  const count = find.locator('[aria-live="polite"]');
  await expect(query).toBeFocused();
  expect(await title.boundingBox()).toEqual(originalBox);
  await query.fill("alpha");
  await expect(count).toHaveText("1/3");
  await query.press("Enter");
  await expect(count).toHaveText("2/3");

  await page.getByRole("button", { name: "源码", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect(query).toHaveValue("alpha");
  await expect(count).toHaveText(/\/3$/);
  await expect(editor.locator(".cm-searchMatch")).toHaveCount(3);
  await expect(find.getByRole("textbox", { name: "替换为" })).toBeHidden();
  await find.getByRole("button", { name: "更多查找选项" }).click();
  await page.getByRole("menuitemcheckbox", { name: "区分大小写" }).click();
  await expect(count).toHaveText(/\/2$/);
  await find.getByRole("button", { name: "替换", exact: true }).click();
  await find.getByRole("textbox", { name: "替换为" }).fill("beta");
  await query.press("ArrowDown");
  await find.getByRole("button", { name: "替换当前" }).click();
  await expect(count).toHaveText(/\/1$/);
  await find.getByRole("button", { name: "全部替换" }).click();
  await expect(editor).toContainText("Alpha beta beta");
  await expect(count).toHaveText("0/0");

  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(query).toHaveValue("alpha");
  await expect(count).toHaveText("1/1");
  await expect(find.getByRole("textbox", { name: "替换为" })).toBeHidden();
  await query.press("Escape");
  await expect(find).toBeHidden();
  await expect(page.getByLabel("预览区")).toBeVisible();
});

test("文件代码预览随主题和字号更新，保留查找焦点与当前命中", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 1500, height: 780 });
  await workspace.goto("/tests/visual/layoutMotionFixture.html?appearance&code-content");
  await workspace.getByRole("button", { name: "打开文件栏" }).click();
  await workspace.getByRole("treeitem", { name: "release.ts" }).click();
  const source = workspace.getByLabel("文件源码");
  const keyword = source.locator(".hljs-keyword").first();
  await expect(keyword).toHaveText("const");
  await workspace.getByRole("button", { name: "搜索文件" }).click();
  const find = workspace.getByRole("dialog", { name: "文件查找" });
  const input = find.getByRole("textbox", { name: "搜索当前文件" });
  const count = find.locator("[aria-live]");
  await input.fill("release");
  await expect(count).toHaveText("1/2");
  await input.press("Enter");
  await expect(count).toHaveText("2/2");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(keyword).toHaveCSS("font-size", `${px - 2}px`);
    await expect(input).toHaveValue("release");
    await expect(input).toBeFocused();
    await expect(count).toHaveText("2/2");
    expect(ratio(await color(keyword, "color"), await color(keyword, "--color-base"))).toBeGreaterThanOrEqual(4.5);
  }
});

test("outline uses a single bulk button and animates nested branches and the whole column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const title = page.getByRole("heading", { name: "文件视图示例" });
  const toggle = page.getByRole("button", { name: "大纲", exact: true });
  await widthTransition(title, () => toggle.click());
  const outline = page.getByRole("navigation", { name: "文件大纲" });
  await outline.getByRole("button", { name: "全部展开" }).click();
  await expect(
    outline.getByRole("button", { name: "小节", exact: true }),
  ).toBeVisible();
  await expect(outline.getByRole("button", { name: "全部展开" })).toHaveCount(
    0,
  );
  const heights = await outline
    .getByRole("button", { name: "折叠 第一节" })
    .evaluate(async (button) => {
      const branch = document.getElementById(
        button.getAttribute("aria-controls")!,
      )!;
      const height = () => branch.getBoundingClientRect().height;
      height();
      await Promise.all(
        branch.getAnimations().map((animation) => animation.finished),
      );
      const before = height();
      (button as HTMLButtonElement).click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      height();
      const collapse = branch
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "grid-template-rows",
        );
      if (!collapse)
        throw new Error("Expected the shared branch height transition");
      collapse.pause();
      collapse.currentTime = 90;
      const during = height();
      collapse.finish();
      return { before, during, after: height() };
    });
  expect(heights.during).toBeGreaterThan(0);
  expect(heights.during).toBeLessThan(heights.before);
  expect(heights.after).toBe(0);
  await outline.getByRole("button", { name: "全部展开" }).click();
  await outline.getByRole("button", { name: "全部折叠" }).click();
  await expect(
    outline.getByRole("button", { name: "第一节", exact: true }),
  ).toBeHidden();
  await widthTransition(title, () => toggle.click());
  await expect(outline).toBeHidden();
});

test("the outline respects reduced motion for branch and column folding", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/tests/visual/layoutMotionFixture.html");
  await page.getByRole("button", { name: "打开文件栏" }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  const toggle = page.getByRole("button", { name: "大纲", exact: true });
  await toggle.click();
  const outline = page.getByRole("navigation", { name: "文件大纲" });
  await expect(outline.locator(".tree-branch").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await outline.getByRole("button", { name: "展开 第一节" }).click();
  await expect(
    outline.getByRole("button", { name: "小节", exact: true }),
  ).toBeVisible();
  await toggle.click();
  await expect(outline).toBeHidden();
  expect(await toggle.getAttribute("aria-expanded")).toBe("false");
});
test("文件树吸顶目录和原行共用外观，折叠后回到原行并保留焦点", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const documents = await context.newPage();
  await documents.emulateMedia({ reducedMotion: "reduce" });
  await documents.setViewportSize({ width: 1100, height: 670 });
  await documents.goto("/tests/visual/layoutMotionFixture.html?virtual-tree&appearance");
  await documents.getByRole("button", { name: "打开文件栏" }).click();
  const tree = documents.getByRole("tree", { name: "layout-motion" });
  const docs = tree.getByRole("treeitem", { name: "docs", exact: true });
  await docs.press("ArrowRight");
  const original = tree.getByRole("treeitem", { name: "发布检查", exact: true });
  await original.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: "发布检查项-001.md" })).toBeVisible();
  expect(await tree.getByRole("treeitem").count()).toBeLessThan(150);
  await expect(original).toBeFocused();
  await expect(original).toHaveAttribute("aria-selected", "true");
  await expect(original.locator("svg")).toHaveCount(1);
  const openFolderDrawing = await original.locator("svg path").getAttribute("d");
  expect(openFolderDrawing).toBeTruthy();
  const scroll = tree.locator("..");
  const scrollOffset = 28 * 45;
  await scroll.evaluate((el, top) => { el.scrollTop = top; }, scrollOffset);
  const sticky = scroll.locator(".sticky").getByRole("treeitem", { name: "发布检查", exact: true });
  await expect(sticky).toBeInViewport();
  await expect(sticky).toHaveAttribute("aria-selected", "true");
  await expect(sticky.locator("svg")).toHaveCount(1);
  await expect(sticky.locator("svg path")).toHaveAttribute("d", openFolderDrawing!);
  await sticky.press("Shift+F10");
  const menu = documents.getByRole("menu", { name: "发布检查" });
  await expect(menu).toBeFocused();
  await menu.press("Escape");
  await expect(sticky).toBeFocused();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(sticky).toHaveCSS("font-size", px + "px");
    await expect(sticky).toHaveAttribute("aria-expanded", "true");
    await expect(sticky).toHaveAttribute("aria-selected", "true");
    await expect(sticky).toBeFocused();
    await expect(sticky).not.toHaveCSS("box-shadow", "none");
    const selected = await color(sticky, "--color-selected");
    await expect.poll(() => color(sticky, "background-color")).toEqual(selected);
    const surface = blend(selected, await color(sticky, "--color-base"));
    expect(ratio(await color(sticky, "color"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(await color(sticky, "--color-focus-ring"), surface)).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => Math.abs(
      (await sticky.locator("svg").boundingBox())!.width - 16 * px / 14,
    )).toBeLessThan(0.1);
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(scrollOffset);
  }
  await sticky.press("ArrowLeft");
  await expect(sticky).toBeHidden();
  await expect(original).toHaveAttribute("aria-expanded", "false");
  await expect(original.locator("svg path")).not.toHaveAttribute("d", openFolderDrawing!);
  await expect(original).toHaveAttribute("aria-selected", "true");
  await expect(original).toBeInViewport();
  await expect(original).toBeFocused();
  await original.press("ArrowRight");
  await expect(original).toBeFocused();
  await expect(tree.getByRole("treeitem", { name: "发布检查项-001.md" })).toBeVisible();
});
