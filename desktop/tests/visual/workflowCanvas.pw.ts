import { expect, test } from "@playwright/test";

test("工作流面包屑在窄栏切换外观后保留焦点并可键盘返回原筛选结果", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 300, height: 560 });
  await workflow.goto("/tests/visual/workflowFixture.html?panel&appearance");
  // 面板首页就是运行管理（ADR 038：模板在左侧功能区）。
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
    await expect(step).toHaveCSS("outline-style", "none");
    await expect(step).toHaveCSS("box-shadow", /0px -2px 0px 0px inset/);
  }
  await step.press("Escape");
  await expect(subflow).toHaveAttribute("aria-expanded", "false");
  await expect(subflow).toBeFocused();
  await expect(step).toBeHidden();
  await subflow.press("Escape");
  await expect(stage).toHaveAttribute("aria-expanded", "false");
  await expect(stage).toBeFocused();
});

test("运行管理的筛选草稿、选区和焦点在外观更新后保留", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.goto("/tests/visual/workflowFixture.html?panel&appearance");
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
  // 行尾的删除图标：点一下变成「确认删除」，换肤时焦点留在确认上，Esc 退回图标。
  const row = workflow.locator("li", {
    has: workflow.getByRole("button", { name: /查看运行 整理交接记录/ }),
  });
  const remove = row.getByRole("button", { name: "删除", exact: true });
  await remove.press("Enter");
  const confirm = row.getByRole("button", { name: "确认删除" });
  await expect(confirm).toBeFocused();
  await page.getByRole("button", { name: "暗夜", exact: true }).click();
  await font.fill("20");
  await font.press("Enter");
  await expect(confirm).toBeFocused();
  await expect(confirm).not.toHaveCSS("box-shadow", "none");
  await confirm.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(remove).toBeFocused();
  await expect(field).toHaveValue("整理交接记录");
});

test("工作流 AI 输入框换肤后保留已输入要求、选区与焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 390, height: 620 });
  // 「用 AI 新建」在左侧「工作流」功能区的侧栏里（ADR 038）。
  await workflow.goto("/tests/visual/workflowFixture.html?compose&appearance");
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

test("窄栏首页是运行管理，返回时保留筛选", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/visual/workflowFixture.html?panel");
  const manager = page.getByRole("region", { name: "运行管理" });
  await expect(manager.getByRole("region", { name: "待处理" })).toContainText(
    "确认设计方案",
  );
  await expect(manager.getByRole("region", { name: "运行记录" })).toContainText(
    "整理交接记录",
  );
  const archived = manager.getByRole("button", { name: "显示已归档" });
  await archived.click();
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await archived.press("Space");
  await expect(archived).toHaveAttribute("aria-pressed", "false");
  await expect(archived).toBeFocused();
  await manager.getByRole("searchbox").fill("交接");
  await expect(manager.getByRole("region", { name: "待处理" })).toHaveCount(0);
  await manager.getByRole("button", { name: /查看运行 整理交接记录/ }).click();
  await page
    .getByRole("navigation", { name: "工作流路径" })
    .getByRole("button", { name: "运行管理" })
    .click();
  await expect(manager.getByRole("searchbox")).toHaveValue("交接");
  expect(await manager.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
