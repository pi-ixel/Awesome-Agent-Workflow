import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

test("工作流起点原生单选在双主题与三档字号下保留焦点和所选入口", async ({ page, context }) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 320, height: 660 });
  await workflow.goto("/tests/visual/workflowFixture.html?files&entries&appearance");
  const group = workflow.getByRole("group", { name: "从哪里开始" });
  const initial = group.getByRole("radio").first();
  const release = group.getByRole("radio", { name: /从发布审查开始/ });
  const mark = release.locator("+ span");
  const row = release.locator("..");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await expect(initial).toBeChecked();
  await initial.press("ArrowDown");
  const checklist = workflow.getByRole("textbox", { name: "发布清单" });
  await checklist.fill("检查版本签名与回滚演练");
  await release.press("Shift");

  for (const [theme, px] of [["暖白", 12], ["暗夜", 20], ["暖白", 14]] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(release).toBeChecked();
    await expect(release).toBeFocused();
    await expect(mark).not.toHaveCSS("box-shadow", "none");
    await expect(row).toHaveCSS("font-size", `${px}px`);
    expect((await mark.boundingBox())!.width).toBeCloseTo((16 * px) / 14, 1);
    const base = await color(workflow.locator("main"), "background-color");
    await expect.poll(async () => {
      const background = blend(await color(row, "background-color"), base);
      return ratio(await color(row, "color"), background);
    }).toBeGreaterThanOrEqual(4.5);
    await expect(checklist).toHaveValue("检查版本签名与回滚演练");
  }
  await release.press("ArrowUp");
  await expect(initial).toBeChecked();
  await expect(initial).toBeFocused();
  await expect(checklist).toBeHidden();
});

test("工作流面包屑在窄栏切换外观后保留焦点并可键盘返回原筛选结果", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 300, height: 560 });
  await workflow.goto("/tests/visual/workflowFixture.html?panel&appearance");
  const runs = workflow.getByRole("tab", { name: "运行管理" });
  await runs.click();
  const search = workflow.getByRole("searchbox", { name: "搜索运行" });
  await search.fill("整理交接");
  const result = workflow.getByRole("button", {
    name: /^查看运行 整理交接记录/,
  });
  await result.press("Enter");
  const path = workflow.getByRole("navigation", { name: "工作流路径" });
  const back = path.getByRole("button", { name: "运行管理" });
  const current = path.locator('[aria-current="page"]');
  await expect(current).toHaveText("运行详情");
  await back.press("Shift");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workflow.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(back).toBeFocused();
    await expect(back).not.toHaveCSS("box-shadow", "none");
    await expect(current).toHaveText("运行详情");
    expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }
  await back.press("Enter");
  await expect(path).toBeHidden();
  await expect(runs).toBeFocused();
  await expect(runs).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("整理交接");
  await expect(result).toBeVisible();
  await expect(
    workflow.getByRole("button", { name: /^查看运行 确认设计方案/ }),
  ).toHaveCount(0);
});

test("展开任务阶段和子流程后切换外观，保留焦点并可用 Escape 逐级返回", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.emulateMedia({ reducedMotion: "reduce" });
  await workflow.setViewportSize({ width: 780, height: 650 });
  await workflow.goto("/tests/visual/workflowFixture.html?appearance");
  const canvas = workflow.getByRole("region", { name: "流程画布" });
  const stage = canvas.locator('[data-stage="task"]');
  await stage.press("Enter");
  await expect(stage).toHaveAttribute("aria-expanded", "true");
  const subflow = canvas.getByRole("button", { name: /任务开发.*子流程/ });
  await subflow.press("Enter");
  await expect(subflow).toHaveAttribute("aria-expanded", "true");
  const step = canvas.getByRole("button", { name: /^实现与测试/ });
  await step.press("Shift");
  await expect(step).toBeFocused();
  const minimap = canvas.locator(".wf-map.show canvas");
  const hasStagePalette = () => minimap.evaluate((el: HTMLCanvasElement) => {
    const stage = el.closest(".wf-flow")!.querySelector(".wf-stage")!;
    const sample = document.createElement("canvas").getContext("2d")!;
    sample.fillStyle = getComputedStyle(stage).backgroundColor;
    sample.fillRect(0, 0, 1, 1);
    const expected = sample.getImageData(0, 0, 1, 1).data;
    sample.globalAlpha = 0.08;
    sample.fillStyle = getComputedStyle(el).getPropertyValue("--color-ink-mute").trim();
    sample.fillRect(0, 0, 1, 1);
    const shaded = sample.getImageData(0, 0, 1, 1).data;
    const pixels = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if (expected.every((value, channel) => pixels[i + channel] === value) ||
          shaded.every((value, channel) => pixels[i + channel] === value)) return true;
    }
    return false;
  });
  await expect.poll(hasStagePalette).toBe(true);
  for (const theme of ["暖白", "暗夜"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    if (theme === "暖白") await expect(workflow.locator("html")).toHaveClass(/theme-warm/);
    else await expect(workflow.locator("html")).not.toHaveClass(/theme-warm/);
    await expect.poll(hasStagePalette).toBe(true);
  }
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(workflow.locator("html")).toHaveCSS("--ui-font-size", px + "px");
    await expect(stage).toHaveAttribute("aria-expanded", "true");
    await expect(subflow).toHaveAttribute("aria-expanded", "true");
    await expect(step).toBeFocused();
    await expect.poll(() => color(step, "outline-color")).toEqual(
      await color(step, "--color-focus-ring"),
    );
  }
  await step.press("Escape");
  await expect(subflow).toHaveAttribute("aria-expanded", "false");
  await expect(subflow).toBeFocused();
  await expect(step).toBeHidden();
  await subflow.press("Escape");
  await expect(stage).toHaveAttribute("aria-expanded", "false");
  await expect(stage).toBeFocused();
});

test("项目总览的共享运行行在窄栏和主题切换中保留键盘焦点与打开动作", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const overview = await context.newPage();
  await overview.setViewportSize({ width: 320, height: 500 });
  await overview.goto("/tests/visual/workflowFixture.html?overview&appearance");
  const row = overview.getByRole("button", { name: /^查看运行 检查工作区/ });
  const region = overview.getByRole("region", { name: "AAW 工作流" });
  await row.press("Tab");
  await overview.keyboard.press("Shift+Tab");
  await expect(row).toBeFocused();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, size] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(size));
    await font.press("Enter");
    await expect(row).toHaveCSS("font-size", size + "px");
    await expect(row).toBeFocused();
    await expect(row).not.toHaveCSS("box-shadow", "none");
    expect(await region.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
  await row.press("Enter");
  await expect(overview.locator("html")).toHaveAttribute(
    "data-opened-run",
    "overview-run",
  );
});

test("运行管理的筛选草稿、选区和焦点在外观更新后保留", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.goto("/tests/visual/workflowFixture.html?panel&appearance");
  await workflow.getByRole("tab", { name: "运行管理" }).click();
  const field = workflow.getByRole("searchbox", { name: "搜索运行" });
  await field.fill("整理交接记录");
  await field.press("Home");
  await field.press("Shift+ArrowRight");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [name, size] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await font.fill(String(size));
    await font.press("Enter");
    await expect(workflow.locator("html")).toHaveCSS(
      "--ui-font-size",
      size + "px",
    );
    await expect(field).toHaveValue("整理交接记录");
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLInputElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, 1]);
    await expect(
      workflow.getByRole("button", { name: /查看运行 整理交接记录/ }),
    ).toBeVisible();
  }
  const actions = workflow.getByRole("button", { name: "整理交接记录 的操作" });
  await actions.press("Enter");
  const runMenu = workflow.getByRole("menu", { name: "整理交接记录 的操作" });
  await runMenu.getByRole("menuitem", { name: "删除", exact: true }).press("Enter");
  const confirmation = workflow.getByRole("group", { name: "确认删除" });
  const cancel = confirmation.getByRole("button", { name: "取消" });
  await expect(cancel).toBeFocused();
  await page.getByRole("button", { name: "暗夜", exact: true }).click();
  await font.fill("20");
  await font.press("Enter");
  await expect(confirmation.getByText(/项目里的文件不受影响/)).toHaveCSS("font-size", "18px");
  await expect(cancel).toBeFocused();
  await cancel.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(actions).toBeFocused();
  await expect(field).toHaveValue("整理交接记录");
});

test("工作流 AI 输入框换肤后保留已输入要求、选区与焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 390, height: 620 });
  await workflow.goto("/tests/visual/workflowFixture.html?panel&appearance");
  await workflow.getByRole("button", { name: "用 AI 新建", exact: true }).click();
  const dialog = workflow.getByRole("dialog", { name: "用 AI 新建工作流" });
  const field = dialog.getByRole("textbox");
  await expect(dialog.getByRole("button", { name: "发送" })).toBeDisabled();
  await field.fill("设计完成后需要评审");
  await field.press("Home");
  await field.press("Shift+ArrowRight");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(field).toHaveCSS("font-size", px + "px");
    await expect(field).toHaveValue("设计完成后需要评审");
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ])).toEqual([0, 1]);
    expect(await dialog.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await expect(dialog.getByRole("button", { name: "发送" })).toBeEnabled();
});

test("工作流画布在主题往返切换时保留节点详情、轮次和键盘焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const theme = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await theme("暖白").click();
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 1400, height: 900 });
  await workflow.goto(
    "/tests/visual/workflowFixture.html?inspector&appearance",
  );
  const canvas = workflow.locator(".wf-scroller");
  await expect(workflow.locator("html")).toHaveClass(/theme-warm/);
  await workflow.getByRole("button", { name: /展开步骤/ }).first().click();
  await workflow
    .getByRole("button", { name: /检查工作流节点的长标题.*运行中/ })
    .click();
  const details = workflow.getByRole("complementary", { name: "节点详情" });
  const aside = workflow.locator(".workflow-split-aside");
  const wideDivider = workflow.getByRole("separator", { name: "调整节点详情宽度" });
  await wideDivider.press("ArrowLeft");
  await expect(aside).toHaveCSS("width", "376px");
  const first = details.getByRole("button", { name: "第 1 轮", exact: true });
  await first.click();
  const background = await canvas.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  for (const name of ["暗夜", "暖白"]) {
    await theme(name).click();
    if (name === "暗夜")
      await expect(canvas).not.toHaveCSS("background-color", background);
    else await expect(canvas).toHaveCSS("background-color", background);
    await expect(first).toBeFocused();
    await expect(details).toBeVisible();
    await expect(aside).toHaveCSS("width", "376px");
  }
  await workflow.setViewportSize({ width: 390, height: 850 });
  const stackedDivider = workflow.getByRole("separator", { name: "调整节点详情高度" });
  await stackedDivider.press("ArrowUp");
  await expect(aside).toHaveCSS("height", "336px");
  for (const name of ["暗夜", "暖白"]) {
    await theme(name).click();
    await expect(stackedDivider).toBeFocused();
    await expect(aside).toHaveCSS("height", "336px");
  }
  await workflow.setViewportSize({ width: 1400, height: 900 });
  await expect(aside).toHaveCSS("width", "376px");
  await details.getByRole("button", { name: "打开本轮会话" }).click();
  await expect(workflow.locator("html")).toHaveAttribute(
    "data-opened-session",
    "session-1",
  );
});

/**
 * 流程图外观截图（不在这里断言，断言在 vitest 里）：把 workflowFixture
 * 渲染出来，收起和展开第一个阶段各落盘一张 PNG，供人工核对。
 */
test("capture workflow canvas fixture", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1060 });
  await page.goto("/tests/visual/workflowFixture.html");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm.png", fullPage: true });
  const viewport = page.locator(".wf-flow");
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm-viewport.png" });
  await page.getByRole("button", { name: /展开步骤/ }).first().click();
  await page.waitForTimeout(1200);
  await viewport.screenshot({ path: "../node_modules/.cache/aaw-visual-results/canvas-warm-open.png" });
  await page.goto("/tests/visual/workflowFixture.html?theme=dark");
  await page.waitForTimeout(600);
  await viewport.screenshot({
    path: "../node_modules/.cache/aaw-visual-results/canvas-dark-viewport.png",
  });
});

test("窄面板大字号时可打开指定轮次，详情操作在面板内换行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?inspector");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ui-font-size", "20px");
  });
  await page.getByRole("button", { name: /展开步骤/ }).first().click();
  await page.getByRole("button", { name: /打开「.*」第 18 轮会话/ }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-opened-session",
    "session-18",
  );

  await page
    .getByRole("button", { name: /检查工作流节点的长标题.*运行中/ })
    .click();
  const inspector = page.getByRole("complementary", { name: "节点详情" });
  const actions = inspector.locator(".workflow-inspector-actions");
  const overflows = await actions.evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(overflows).toBe(false);
  await inspector.getByRole("button", { name: "第 1 轮", exact: true }).click();
  await inspector.getByRole("button", { name: "打开本轮会话" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-opened-session",
    "session-1",
  );
  await inspector.screenshot({
    path: "node_modules/.cache/aaw-workflow-ui-inspector.png",
  });
});

test("窄栏首页并列显示工作流库和运行管理，返回时保留筛选", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?panel");
  const nav = page.getByRole("tablist", { name: "工作流面板" });
  await expect(nav.getByRole("tab", { name: "工作流库" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("region", { name: "预置工作流" })).toBeVisible();
  await nav.getByRole("tab", { name: "运行管理" }).click();
  const manager = page.getByRole("region", { name: "运行管理" });
  const archived = manager.getByRole("checkbox", { name: /显示已归档/ });
  await manager.getByText(/^显示已归档/).click();
  await expect(archived).toBeChecked();
  await archived.press("Space");
  await expect(archived).not.toBeChecked();
  await expect(archived).toBeFocused();
  await expect(manager.getByRole("region", { name: "待处理" })).toContainText(
    "确认设计方案",
  );
  await expect(manager.getByRole("region", { name: "运行记录" })).toContainText(
    "整理交接记录",
  );
  await manager.getByRole("searchbox").fill("交接");
  await expect(manager.getByRole("region", { name: "待处理" })).toHaveCount(0);
  await manager.getByRole("button", { name: /查看运行 整理交接记录/ }).click();
  await expect(nav).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "工作流路径" })
    .getByRole("button", { name: "运行管理" })
    .click();
  await expect(manager.getByRole("searchbox")).toHaveValue("交接");
  expect(await manager.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
