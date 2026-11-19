import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { importToolProject } from "../../src/plugins/tools/runtime/projectArchive.ts";

async function selectToolAction(page: Page, tool: string, action: string) {
  await page.getByRole("button", { name: `更多操作：${tool}`, exact: true }).click();
  const item = page.getByRole("menuitem", { name: action, exact: true });
  await expect(item).toBeInViewport();
  await item.click();
}

/**
 * 内容区里不能有元素横向越界。
 *
 * 右栏是 `overflow: hidden`：比容器宽的卡片会被**裁掉**，document.scrollWidth
 * 一点变化都没有 —— 所以"没有横向滚动条"根本证明不了没被裁（300px 下
 * 「可以验收」徽标和"还没有 index.html"就是这么消失的）。这里直接比右边缘。
 */
async function expectNoClip(page: Page, selector = ".tools-content") {
  const clipped = await page.evaluate((target) => {
    const box = document.querySelector<HTMLElement>(target);
    if (!box) return ["missing " + target];
    const right = box.getBoundingClientRect().right;
    return Array.from(box.querySelectorAll("*"))
      .filter((element) => element.getBoundingClientRect().right > right + 0.5)
      .map((element) => element.className || element.tagName)
      .slice(0, 6);
  }, selector);
  expect(clipped).toEqual([]);
}

for (const width of [360, 740, 1100]) for (const theme of ["dark", "warm"]) {
  test(`plugin library and management fit ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`/tests/visual/toolsFixture.html${theme === "warm" ? "?warm" : ""}`);
    await expect(page.getByRole("button", { name: "更多操作：JSON 格式化", exact: true })).toBeVisible();
    // 密度是可验收的指标：360px 宽、850px 高的右栏里至少能看到 7 个工具。
    // 卡片式布局在同样高度只能放 3 个，这一条防止以后又把行高做大回去。
    const visibleRows = () => page.locator(".tool-row").evaluateAll((rows) => rows.filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight).length);
    expect(await visibleRows()).toBeGreaterThanOrEqual(7);
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "20px"));
    // 界面字号调到 20px 时行内小字必须跟着放大（--text-2xs = 基准 − 3px）。
    // 以前这里是写死的 11px：把界面字号调大，工具中心仍是一堆小字不动。
    await expect(page.locator(".tool-row-meta").first()).toHaveCSS("font-size", "17px");
    // 字变大后行高随之变高，能看到的行数自然少一个——这是放大生效的正常结果。
    expect(await visibleRows()).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: `node_modules/.cache/tools-library-${theme}-${width}.png` });
    await selectToolAction(page, "JSON 格式化", "管理");
    await page.getByLabel("缩进空格数", { exact: false }).fill("4");
    await page.getByRole("combobox", { name: "排序方式" }).click();
    await page.getByRole("option", { name: "按名称排序" }).click();
    await page.getByRole("switch", { name: "处理后自动复制" }).check();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("设置已保存");
    await page.getByRole("button", { name: "← 返回工具中心" }).click();
    await selectToolAction(page, "JSON 格式化", "管理");
    await expect(page.getByRole("combobox", { name: "排序方式" })).toHaveText("按名称排序");
    await expect(page.getByRole("switch")).toBeChecked();
    await page.screenshot({ path: `node_modules/.cache/tools-management-${theme}-${width}.png` });
    await page.getByRole("button", { name: /卸载插件/ }).click();
    await page.getByRole("button", { name: "卸载", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "← 返回工具中心" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "← 返回工具中心" }).click();
    await selectToolAction(page, "未声明设置的工具", "管理");
    await expect(page.getByText("此插件暂未提供自定义设置")).toBeVisible();
    await page.getByRole("button", { name: "← 返回工具中心" }).click();
    // 开发指导现在是独立的 Electron 窗口：面板里只保证入口在、能点、不报错。
    const guide = page.getByRole("button", { name: "开发指导 ↗", exact: true });
    await expect(guide).toBeVisible();
    await guide.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: `node_modules/.cache/tools-guide-entry-${theme}-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

// 管理页里那条长长的来源目录曾经把内容撑宽，overflow-y:auto 又让 overflow-x
// 变成 auto，于是整页底部多出一条横向滚动条。documentElement 的 scrollWidth
// 断言抓不到内部滚动容器，所以单独量 .management-scroll。
test("long source dir never causes a horizontal scrollbar in management", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 850 });
  await page.goto("/tests/visual/toolsFixture.html");
  await selectToolAction(page, "JSON 格式化", "管理");
  await page.getByRole("button", { name: /源码与开发/ }).click();
  await expect(page.locator(".mg-source-dir .tool-path code")).toHaveAttribute("data-hint", /json-formatter/);
  expect(await page.locator(".management-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "node_modules/.cache/tools-management-source-360.png" });
});

test("exports a downloadable source ZIP with editable HTML and build script", async ({ page }) => {
  await page.goto("/tests/visual/toolsFixture.html?web");
  const downloading = page.waitForEvent("download");
  await selectToolAction(page, "JSON 格式化", "导出源码");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("json-formatter-1.0.0-source.zip");
  const tool = importToolProject(new Uint8Array(await readFile(await download.path())));
  expect(tool.id).toBe("json-formatter");
  // 源码包不再带 Node 构建脚本，也不该再叫人「拖回」（拖拽导入没实现过）。
  expect(tool.sourceFiles?.["scripts/build.mjs"]).toBeUndefined();
  expect(tool.sourceFiles?.["README.md"]).toContain("导入工具");
  expect(tool.sourceFiles?.["README.md"]).not.toContain("拖");
  expect(tool.html).toContain("aawActions");
  await expect(page.getByRole("status")).toContainText("已导出");
});

for (const width of [360, 740]) {
  test(`unsaved settings warning stays visible after source action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 650 });
    await page.goto(`/tests/visual/toolsFixture.html${width === 360 ? "?warm" : ""}`);
    await selectToolAction(page, "JSON 格式化", "管理");
    await page.getByLabel(/缩进空格数/).fill("4");
    await page.getByRole("button", { name: /返回工具中心/ }).click();
    await expect(page.getByRole("alert")).toBeInViewport();
    await expect(page.getByRole("button", { name: "继续编辑" })).toBeFocused();
    await page.screenshot({ path: `node_modules/.cache/tools-unsaved-${width}.png` });
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.getByLabel(/缩进空格数/)).toHaveValue("4");
    await page.getByRole("button", { name: /返回工具中心/ }).click();
    await page.getByRole("button", { name: "放弃修改并返回" }).click();
    await expect(page.getByRole("list", { name: "已安装工具" })).toBeVisible();
  });
}

// 第一次打开、一个工具都没有时，这一屏是唯一一次讲清"工具能干嘛"的机会。
// 顺手留一张真实渲染截图，窄栏与宽栏都不能出现横向滚动。
for (const width of [360, 1100]) {
  test(`empty library guides the first tool at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/tests/visual/toolsFixture.html?empty");
    await expect(page.getByText("从你的想法开始，做一个自己的工具")).toBeVisible();
    await expect(page.getByRole("button", { name: /开始做工具/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入工具…", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "载入示例工具", exact: true })).toBeVisible();
    // 主 CTA 明显大于两个备选，且两个备选等高：之前三种按钮各有一套内边距。
    const boxes = await page.evaluate(() => {
      const primary = document.querySelector<HTMLElement>(".tools-empty-primary")!.getBoundingClientRect();
      const alts = [...document.querySelectorAll<HTMLElement>(".tools-empty-alt")].map((el) => el.getBoundingClientRect());
      return { primary: primary.height, alts: alts.map((box) => box.height) };
    });
    expect(boxes.alts).toHaveLength(2);
    expect(boxes.primary).toBeGreaterThan(boxes.alts[0]!);
    expect(Math.abs(boxes.alts[0]! - boxes.alts[1]!)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `node_modules/.cache/tools-empty-${width}.png` });
  });
}

test("loading example tools fills the library", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/tests/visual/toolsFixture.html?empty");
  await page.getByRole("button", { name: "载入示例工具", exact: true }).click();
  const rows = page.getByRole("list", { name: "已安装工具" });
  await expect(rows.getByText("JSON 格式化")).toBeVisible();
  await expect(rows.getByText("随手记")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "node_modules/.cache/tools-examples-1100.png" });
});

for (const width of [300, 360, 740]) {
  test(`stalled project hands the work back to the user at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/tests/visual/toolsFixture.html?stalled");
    await page.getByRole("button", { name: /开发工具/ }).click();
    await expect(page.getByText("按这个路径自己改", { exact: true })).toBeVisible();
    const recheck = page.getByRole("button", { name: "我改完了，重新校验", exact: true });
    // 300px 下交接块在首屏之外（内容更高），但必须**滚得到**、且不被裁。
    await recheck.scrollIntoViewIfNeeded();
    await expect(recheck).toBeInViewport();
    // 路径不再是按钮：完整值在 data-hint 里，窄栏省略但不丢信息。
    await expect(page.locator(".build-stalled .tool-path code")).toHaveAttribute("data-hint", "E:/AAW/tools/projects/u1/json-table");
    // 窄面板下"说明 + 两个按钮"不能撑出横向滚动条。
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectNoClip(page);
    await page.screenshot({ path: `node_modules/.cache/tools-stalled-${width}.png` });
    // 列表行里的路径也是文本：滚到底确认它没被挤成半行。
    const rowPath = page.getByRole("list", { name: "工具项目" }).locator(".tool-path code").first();
    await rowPath.scrollIntoViewIfNeeded();
    await expect(rowPath).toBeInViewport();
    await page.screenshot({ path: `node_modules/.cache/tools-stalled-list-${width}.png` });
  });
}

for (const width of [300, 360, 740]) {
  test(`one row per project, only the open one expands at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/tests/visual/toolsFixture.html?projects");
    await page.getByRole("button", { name: /开发工具/ }).click();

    const rows = page.getByRole("list", { name: "工具项目" }).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    // 展开的内容只属于一行：源码路径出现一次；另外两行是收起的。
    await expect(page.getByText("源码位置")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "接口 JSON 转表格" })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Markdown 导出" })).toHaveAttribute("aria-expanded", "false");
    // 窄栏不能因为"多一个展开块"撑出横向滚动条。
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 卡片必须跟着面板宽度走。300px 右栏（content 272）时它曾经宽 44px、
    // 右侧被 overflow: hidden 裁掉——徽标和"还没有 index.html"就那样消失了。
    const sizes = await page.evaluate(() => {
      const content = document.querySelector(".tools-content") as HTMLElement;
      const style = getComputedStyle(content);
      const available = content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const row = document.querySelector(".build-project") as HTMLElement;
      return { available, row: row.getBoundingClientRect().width };
    });
    expect(sizes.row).toBeLessThanOrEqual(sizes.available + 1);
    expect(sizes.row).toBeGreaterThanOrEqual(sizes.available - 1);
    await expectNoClip(page);
    await page.screenshot({ path: `node_modules/.cache/tools-projects-${width}.png` });
    // 再点一次标题就收起：这是僵尸卡片缺的那条出口。
    await page.getByRole("button", { name: "接口 JSON 转表格" }).click();
    await expect(page.getByText("源码位置")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "接口 JSON 转表格" })).toHaveAttribute("aria-expanded", "false");
  });
}

for (const width of [300, 360, 740]) {
  test(`a project without a verdict yet stays actionable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/tests/visual/toolsFixture.html?blank");
    await page.getByRole("button", { name: /开发工具/ }).click();

    // 结论还没到（check 为 null）：不能因此把整行变成灰按钮。
    const open = page.locator(".build-project.is-open");
    await expect(open.getByRole("button", { name: "继续开发", exact: true })).toBeEnabled();
    await expect(open.getByRole("button", { name: "重新校验", exact: true })).toBeEnabled();
    // 没通过校验就不该能装：出货按钮必须是禁用态。
    await expect(open.getByRole("button", { name: "确认安装", exact: true })).toBeDisabled();
    // 页签上的数字要与列表头一致（合成行也要算进去）。
    await expect(page.getByRole("button", { name: /开发工具 · 3/ })).toBeVisible();
    // 还没读盘也不能断言"没有 index.html"——会让用户以为 AI 什么都没写。
    // （列表里另有一个真的没有 index.html 的项目，所以只看展开的这一行。）
    await expect(open.getByText("还没有 index.html")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectNoClip(page);
    await page.screenshot({ path: `node_modules/.cache/tools-blank-${width}.png` });
  });
}

/**
 * 面板必须铺满右栏，不能塌成一条竖条。
 *
 * `.aaw-tools` 是 `container-type: inline-size` 容器，固有宽度会被抑制；一旦
 * 它的父级是横排 flex（`flex` 而没有 `flex-col`），flex-basis 就是 0，只剩
 * padding —— 宽度二三十像素，「工具中心」四个字一字一行。夹具现在挂的是
 * 真实外壳 `ToolsPanelSurface`，所以这条断言同时守住"外壳别改回横排 flex"。
 */
for (const width of [300, 360, 740]) {
  test(`tool panel fills the pane at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/tests/visual/toolsFixture.html");
    const title = page.getByRole("heading", { name: "工具中心", exact: true });
    await expect(title).toBeVisible();

    expect((await page.locator(".aaw-tools").boundingBox())?.width).toBeGreaterThan(width - 2);
    // 一行的高度是 26px；塌成竖条时这里会是七八十甚至更高。
    expect((await title.boundingBox())?.height).toBeLessThan(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `node_modules/.cache/tools-pane-${width}.png` });
  });
}
