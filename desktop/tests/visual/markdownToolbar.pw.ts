import { expect, test, type Locator } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

test("图表缩放菜单用方向键选择，退出时将焦点还给缩放按钮", async ({ page }) => {
  await page.goto("/tests/visual/uiScaleFixture.html?markdown");
  await page.getByRole("button", { name: "放大预览图表" }).click();
  const dialog = page.getByRole("dialog", { name: "Mermaid 图表" });
  const trigger = dialog.getByRole("button", { name: "缩放比例" });
  const menu = dialog.getByRole("menu", { name: "图表缩放" });
  await trigger.press("Enter");
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "50%", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "重置缩放" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("50%");
  await expect(trigger).toBeFocused();
});

test("打开的 Mermaid 预览保留缩放与焦点，并重新绘制当前主题的节点和文字", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const document = await context.newPage();
  await document.setViewportSize({ width: 400, height: 720 });
  await document.goto("/tests/visual/uiScaleFixture.html?markdown&secondary");
  await document.getByRole("button", { name: "放大预览图表" }).click();
  const preview = document.getByRole("dialog", { name: "Mermaid 图表" });
  const zoomIn = preview.getByRole("button", { name: "放大", exact: true });
  await zoomIn.press("Enter");
  const zoom = preview.getByRole("button", { name: "缩放比例" });
  const initialZoom = await zoom.innerText();
  const node = preview.locator(".node rect").first();
  const label = preview.locator(".node .nodeLabel").first();
  const initial = await node.evaluate((el) => getComputedStyle(el).fill);
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(label).toHaveCSS("font-size", `${px}px`);
    if (theme === "暗夜") await expect(node).toHaveCSS("fill", initial);
    else await expect(node).not.toHaveCSS("fill", initial);
    await expect(zoom).toHaveText(initialZoom);
    await expect(zoomIn).toBeFocused();
    const background = blend(
      await color(node, "fill"),
      await color(label, "--color-surface"),
    );
    expect(
      ratio(await color(label, "color"), background),
    ).toBeGreaterThanOrEqual(4.5);
  }
});

async function checkButton(button: Locator, label: string, size: number) {
  await expect(button).toHaveAttribute("data-hint", label);
  await expect(button).toHaveCSS("width", size + "px");
  await expect(button).toHaveCSS("height", size + "px");
}

test("长表格预览在换肤时保留滚动位置和焦点，最大字号仍可读", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const document = await context.newPage();
  await document.setViewportSize({ width: 370, height: 650 });
  await document.goto(
    "/tests/visual/fixture.html?markdown-toolbar&long-table&appearance",
  );
  const trigger = document.getByRole("button", {
    name: "表格预览",
    exact: true,
  });
  await trigger.press("Enter");
  const dialog = document.getByRole("dialog", { name: "表格预览" });
  const scroll = dialog.getByLabel("预览表格滚动");
  await scroll.focus();
  await scroll.evaluate((el) => el.scrollTo({ top: 350, behavior: "instant" }));
  const readTop = () => scroll.evaluate((el) => el.scrollTop);
  await expect.poll(readTop).toBeGreaterThan(0);
  const initial = await readTop();
  const header = scroll.getByRole("columnheader", { name: "项目" });
  await expect(header).toHaveCSS("position", "sticky");
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 14],
    ["暗夜", 20],
    ["暖白", 12],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    if (px === 14) await expect.poll(readTop).toBe(initial);
    await font.fill(String(px));
    await font.press("Enter");
    await expect(header).toHaveCSS("font-size", `${px}px`);
    await expect(scroll).toBeFocused();
    await expect.poll(readTop).toBeGreaterThan(0);
    expect(
      ratio(
        await color(header, "color"),
        await color(header, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  }
  await scroll.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const theme of ["warm", "dark"]) {
  test(
    theme + " 小字号下复制失败可重试，成功后恢复复制图标",
    async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(
        "/tests/visual/fixture.html?markdown-toolbar&theme=" + theme,
      );
      const copy = page.getByRole("button", { name: "复制代码" });
      const glyph = copy.locator("svg");
      await expect(glyph).toHaveAttribute("viewBox", "0 0 24 24");
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--ui-font-size", "12px");
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new Error("denied")),
        });
      });
      await expect
        .poll(() =>
          glyph.evaluate((el) => parseFloat(getComputedStyle(el).width)),
        )
        .toBeCloseTo((16 * 12) / 14, 1);
      const width = await glyph.evaluate((el) => getComputedStyle(el).width);
      await copy.press("Enter");
      await expect(copy).toHaveAttribute("data-hint", "复制失败");
      await page.evaluate(() =>
        Reflect.deleteProperty(navigator.clipboard, "writeText"),
      );
      await copy.press("Enter");
      await expect(copy).toHaveAttribute("data-hint", "已复制");
      await expect(glyph.locator("rect")).toHaveCount(0);
      await expect(glyph).toHaveCSS("width", width);
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
      ).toContain("flowchart LR");
      await expect(copy).toHaveAttribute("data-hint", "复制代码");
      await expect(glyph.locator("rect")).toHaveCount(1);
    },
  );
  test(
    theme + " 主题的 Markdown 工具栏保留点击区和键盘操作",
    async ({ page }) => {
      await page.goto(
        "/tests/visual/fixture.html?markdown-toolbar&theme=" + theme,
      );
      const button = (name: string) =>
        page.getByRole("button", { name, exact: true });
      for (const name of ["复制 Markdown", "下载 CSV", "表格预览"]) {
        await checkButton(button(name), name, 24);
      }
      await button("表格预览").press("Enter");
      const table = page.getByRole("dialog", { name: "表格预览" });
      await expect(table).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(table).toBeHidden();
      await expect(button("放大预览图表")).toBeEnabled({ timeout: 15000 });
      await button("放大预览图表").press("Enter");
      const diagram = page.getByRole("dialog", { name: "Mermaid 图表" });
      await expect(diagram).toBeVisible();
      for (const name of ["缩小", "放大", "关闭"]) {
        await checkButton(
          diagram.getByRole("button", { name, exact: true }),
          name,
          28,
        );
      }
      const zoom = diagram.getByRole("button", { name: "缩放比例" });
      const initial = await zoom.innerText();
      await button("缩小").press("Space");
      await expect(zoom).not.toHaveText(initial);
      await button("关闭").press("Enter");
      await expect(diagram).toBeHidden();
      await expect(button("放大预览图表")).toBeFocused();
    },
  );
}
