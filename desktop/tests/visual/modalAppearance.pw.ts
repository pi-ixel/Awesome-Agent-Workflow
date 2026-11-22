import { expect, test, type Page } from "@playwright/test";
import { color, ratio } from "./contrast.ts";

test("诊断资源页在宽窗和窄窗展示 Desktop 的同一时刻工作集", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1380, height: 840 });
  await page.goto("/tests/visual/fixture.html?diagnostics-window&resources", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "资源与连接" }).click();
  const table = page.getByRole("table").filter({ hasText: "Desktop 合计" });
  await expect(
    table.getByRole("columnheader", { name: /峰值时刻/ }),
  ).toBeVisible();
  const browser = table.getByRole("row", { name: /内嵌浏览器/ });
  await expect(browser.getByRole("cell").nth(1)).toContainText("1.12 GiB");
  await expect(browser.getByRole("cell").nth(2)).toContainText("640 MiB");
  await page.setViewportSize({ width: 800, height: 700 });
  await expect(table).toBeInViewport();
  expect(
    await table.evaluate(
      (element) => element.getBoundingClientRect().width <= element.parentElement!.clientWidth,
    ),
  ).toBe(true);
  await page.getByText("工作集明细", { exact: true }).click();
  await expect(table).toBeHidden();
});

const appearances = [
  ["暖白", 12],
  ["暗夜", 20],
  ["暖白", 14],
] as const;

async function changeAppearance(page: Page, theme: string, px: number) {
  await page.getByRole("button", { name: theme, exact: true }).click();
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  await font.fill(String(px));
  await font.press("Enter");
}

test("会话批注换肤保留修改草稿、选区和焦点，Esc 归还入口焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  await workspace.setViewportSize({ width: 300, height: 440 });
  await workspace.goto(
    "/tests/visual/uiScaleFixture.html?annotation-summary&secondary",
  );
  const trigger = workspace.getByRole("button", { name: "1 条评论" });
  const surface = workspace.getByRole("dialog", { name: "文档评论" });
  await trigger.press("Enter");
  await expect(surface).toBeFocused();
  await expect(surface).toHaveAttribute("data-hint-open", "true");
  const edit = surface.getByRole("button", { name: "编辑批注 发布检查.md" });
  await workspace.keyboard.press("Tab");
  await expect(edit).toBeFocused();
  await edit.press("Space");
  const draft = surface.getByRole("textbox", { name: "修改批注意见" });
  await expect(draft).toBeFocused();
  const value = "回滚验证通过，待复核签名。";
  await draft.fill(value);
  await draft.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(0, 4),
  );
  await workspace.mouse.move(0, 0);

  const backgrounds: string[] = [];
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(draft).toHaveCSS("font-size", `${px}px`);
    await expect(draft).toHaveValue(value);
    await expect(draft).toBeFocused();
    expect(
      await draft.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, 4]);
    backgrounds.push(
      await surface.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
  }
  expect(backgrounds[0]).toBe(backgrounds[2]);
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
  await draft.press("Tab");
  const save = surface.getByRole("button", { name: "保存" });
  await expect(save).toBeFocused();
  await save.press("Enter");
  await expect(surface.getByText(value)).toBeVisible();
  await edit.press("Escape");
  await expect(surface).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("更新说明可在窄窗键盘阅读，实时换肤保留滚动与操作焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workspace = await context.newPage();
  const errors: string[] = [];
  workspace.on("pageerror", (error) => errors.push(error.message));
  await workspace.setViewportSize({ width: 300, height: 440 });
  await workspace.goto(
    "/tests/visual/uiScaleFixture.html?update-button&secondary",
  );
  const trigger = workspace.getByRole("button", { name: "更新 Desktop" });
  const surface = workspace.getByRole("region", { name: "v0.1.53 更新日志" });
  await trigger.focus();
  await expect(surface).toBeVisible();
  await workspace.keyboard.press("Tab");
  await expect(surface).toBeFocused();
  const notes = surface.getByRole("heading", { name: "工作流" });
  const scroller = notes.locator(
    "xpath=ancestor::div[contains(@class, 'overscroll-contain')]",
  );
  await workspace.keyboard.press("Tab");
  await expect(scroller).toBeFocused();
  await workspace.keyboard.press("Tab");
  const history = surface.getByRole("button", { name: "查看全部更新日志" });
  await expect(history).toBeFocused();
  await scroller.evaluate((el) => {
    el.scrollTop = 24;
  });
  await workspace.mouse.move(0, 0);

  const backgrounds: string[] = [];
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(workspace.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    await expect(history).toBeFocused();
    await expect(notes).toBeVisible();
    await expect(scroller).toHaveJSProperty("scrollTop", 24);
    expect(
      await surface.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= 15.5 &&
          rect.right <= innerWidth - 15.5 &&
          rect.top >= 15.5 &&
          rect.bottom <= innerHeight - 15.5
        );
      }),
    ).toBe(true);
    backgrounds.push(
      await surface.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    expect(
      ratio(
        await color(history, "color"),
        await color(surface, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  }
  expect(backgrounds[0]).toBe(backgrounds[2]);
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
  await history.press("Enter");
  await expect(workspace.locator("html")).toHaveAttribute(
    "data-opened-url",
    /Awesome-Agent-Workflow\/releases$/,
  );
  await history.press("Escape");
  await expect(surface).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(workspace.locator("html")).toHaveAttribute(
    "data-update-dialog",
    "true",
  );
  expect(errors).toEqual([]);
});

test("工作流撰写弹窗只锁定工作流面板，实时保留草稿、选区和提交焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const workflow = await context.newPage();
  await workflow.setViewportSize({ width: 420, height: 740 });
  const pageErrors: string[] = [];
  workflow.on("pageerror", (error) => pageErrors.push(error.message));
  let requestCount = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await workflow.route(
    "**/workflowFixture.html?sample-compose-request",
    async (route) => {
      requestCount++;
      await pending;
      await route.fulfill({ status: 503 });
    },
  );
  await workflow.goto("/tests/visual/workflowFixture.html?compose&appearance");
  const opener = workflow.getByRole("button", { name: "用 AI 新建" });
  await opener.press("Enter");
  const dialog = workflow.getByRole("dialog", { name: "用 AI 新建工作流" });
  const input = dialog.getByRole("textbox");
  const send = dialog.getByRole("button", { name: "发送" });
  const close = dialog.getByRole("button", { name: "关闭" });
  const backdrop = dialog.locator("..");
  await expect(input).toBeFocused();
  await expect(send).toBeDisabled();
  await expect(workflow.locator(".workflow-scroll")).toHaveJSProperty(
    "inert",
    true,
  );
  await workflow.getByRole("button", { name: "项目工具" }).click();
  await expect(workflow.locator("html")).toHaveAttribute(
    "data-project-tool",
    "opened",
  );
  await expect(dialog).toBeVisible();
  const text = [
    "校验发布产物",
    "核对权限配置",
    "复核签名",
    "准备灰度发布",
    "待人工确认",
    "准备回滚",
    "生成交接记录",
  ].join("\n");
  await input.fill(text);
  await input.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(2, 7),
  );
  await backdrop.click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  let shortHeight = 0;
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(input).toHaveCSS("font-size", `${px}px`);
    await expect(input).toHaveValue(text);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return [textarea.selectionStart, textarea.selectionEnd];
      }),
    ).toEqual([2, 7]);
    expect(
      ratio(
        await color(input, "color"),
        await color(dialog, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    if (px === 12) shortHeight = (await input.boundingBox())!.height;
    if (px === 20)
      await expect
        .poll(async () => (await input.boundingBox())!.height)
        .toBeGreaterThan(shortHeight);
  }
  await send.press("Tab");
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(send).toBeFocused();
  await input.press("Enter");
  await expect(input).toHaveJSProperty("readOnly", true);
  await expect(send).toHaveAttribute("aria-busy", "true");
  await expect(input).toBeFocused();
  await input.press("Enter");
  await input.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => requestCount).toBe(1);
  finish();
  await expect(dialog.getByRole("alert")).toContainText(
    "工作流编辑会话启动失败",
  );
  await expect(input).toHaveValue(text);
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(pageErrors).toEqual([]);
  await opener.press("Enter");
  await backdrop.click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("独立诊断窗口的原文弹窗在三档字号下保留选区，关闭归还焦点", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const diagnostics = await context.newPage();
  await diagnostics.setViewportSize({ width: 400, height: 700 });
  let finish!: () => void;
  let requests = 0;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await diagnostics.route(
    "**/fixture.html?sample-diagnostics-request",
    async (route) => {
      requests++;
      await pending;
      await route.fulfill({ status: requests === 1 ? 200 : 503 });
    },
  );
  await diagnostics.goto("/tests/visual/fixture.html?diagnostics-window");
  const opener = diagnostics.getByRole("button", { name: "查看原文" });
  await opener.press("Enter");
  const dialog = diagnostics.getByRole("dialog", { name: "ACP 原始报文" });
  const close = dialog.getByRole("button", { name: "关闭原文" });
  const copy = dialog.getByRole("button", { name: "复制原文" });
  await expect(close).toBeFocused();
  await expect(dialog.getByRole("status")).toContainText("正在读取原文");
  await expect(copy).toBeDisabled();
  await expect(diagnostics.locator("#root")).toHaveJSProperty("inert", true);
  await close.press("Tab");
  await expect(close).toBeFocused();
  finish();
  const content = dialog.getByLabel("原文内容");
  await expect(content).toContainText("发布检查示例");
  await expect(copy).toBeEnabled();
  await content.focus();
  await content.evaluate((element) => {
    const token = "发布检查示例";
    const start = element.textContent.indexOf(token);
    const range = document.createRange();
    range.setStart(element.firstChild!, start);
    range.setEnd(element.firstChild!, start + token.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(content).toHaveCSS("font-size", `${px - 2}px`);
    await expect(content).toBeFocused();
    expect(
      await diagnostics.evaluate(() => document.getSelection()?.toString()),
    ).toBe("发布检查示例");
    expect(
      ratio(
        await color(content, "color"),
        await color(dialog, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  }
  await content.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("原始报文读取失败");
  await expect(copy).toBeDisabled();
  expect(await color(error, "color")).toEqual(
    await color(error, "--color-danger-ink"),
  );
  await close.press("Enter");
  await expect(opener).toBeFocused();
});

test("日志详情浮层可用键盘进入，切换外观后可关闭或继续关联查询", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const diagnostics = await context.newPage();
  await diagnostics.setViewportSize({ width: 400, height: 700 });
  await diagnostics.goto("/tests/visual/fixture.html?diagnostics-window");
  const trigger = diagnostics.getByRole("button", {
    name: "详情：收到工作区初始化结果",
  });
  const panel = diagnostics.getByRole("dialog", { name: "原始日志详情" });
  const related = panel.getByRole("button", { name: "关联操作" });
  const heading = diagnostics.getByRole("heading", { name: "AAW Desktop 诊断" });
  const mark = heading.locator("xpath=ancestor::header").locator("img");
  await trigger.press("Enter");
  await expect(related).toBeFocused();
  await expect(diagnostics.locator("#root")).toHaveJSProperty("inert", false);
  const content = panel.locator("pre");
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(related).toBeFocused();
    await expect(content).toHaveCSS("font-size", `${px - 2}px`);
    await expect(content).toContainText("op-release");
    await expect(heading).toHaveCSS("font-size", `${px + 2}px`);
    expect((await mark.boundingBox())!.width).toBeCloseTo((36 * px) / 14, 1);
    expect(ratio(await color(heading, "color"), await color(heading, "--color-base"))).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(
        await color(content, "color"),
        await color(panel, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  }
  await related.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await related.press("Enter");
  await expect(panel).toBeHidden();
  await expect(diagnostics.getByLabel("关键词")).toHaveValue("op-release");
});

test("图片预览切换外观时保留缩放和焦点，关闭后返回缩略图", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const image = await context.newPage();
  await image.setViewportSize({ width: 400, height: 670 });
  await image.goto(
    "/tests/visual/fixture.html?image-attachments=draft&appearance",
  );
  const thumbnail = image.getByRole("button", { name: "预览 screenshot.png" });
  await thumbnail.press("Enter");
  const dialog = image.getByRole("dialog", { name: "图片预览" });
  const zoom = dialog.getByRole("button", { name: "放大" });
  const close = dialog.getByRole("button", { name: "关闭(Esc)" });
  await zoom.press("Enter");
  await expect(dialog.getByText("150%", { exact: true })).toBeVisible();
  await expect(zoom).toBeFocused();
  for (const [theme, px] of appearances) {
    await changeAppearance(page, theme, px);
    await expect(close).toHaveCSS("font-size", `${px - 2}px`);
    await expect(zoom).toBeFocused();
    await expect(dialog.getByText("150%", { exact: true })).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await zoom.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(thumbnail).toBeFocused();
});
