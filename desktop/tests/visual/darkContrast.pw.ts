import { expect, test, type Locator } from "@playwright/test";

type Color = [number, number, number, number];
function parse(value: string): Color {
  const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
}
function blend(fg: Color, bg: Color): Color {
  return [0, 1, 2]
    .map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]))
    .concat(1) as Color;
}
function ratio(a: Color, b: Color): number {
  const luminance = (c: Color) =>
    c
      .slice(0, 3)
      .map((n) => n / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light! + 0.05) / (dark! + 0.05);
}
async function color(el: Locator, property: string): Promise<Color> {
  return el.evaluate((node, key) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建颜色解析上下文");
    context.fillStyle = getComputedStyle(node).getPropertyValue(key);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = context.getImageData(
      0,
      0,
      1,
      1,
    ).data;
    return [r, g, b, a / 255] as Color;
  }, property);
}

test("dark theme keeps controls, status and readable content distinct", async ({
  page,
}) => {
  await page.goto("/tests/visual/darkContrastFixture.html");
  const surface = page.getByTestId("surface"),
    bg = await color(surface, "background-color");
  for (const id of ["muted", "faint"])
    expect(
      ratio(await color(page.getByTestId(id), "color"), bg),
      id,
    ).toBeGreaterThanOrEqual(4.5);
  const composerBorder = await color(
    page.getByTestId("composer-border"),
    "border-top-color",
  );
  for (const name of ["普通按钮", "本地边框按钮", "新建会话"]) {
    const button = page.getByRole("button", { name });
    expect(await color(button, "border-top-color"), name).toEqual(
      composerBorder,
    );
    expect(
      ratio(await color(button, "color"), bg),
      name,
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const name of ["主按钮", "危险操作"]) {
    const action = page.getByRole("button", { name });
    expect(
      ratio(
        await color(action, "color"),
        await color(action, "background-color"),
      ),
      name,
    ).toBeGreaterThanOrEqual(4.5);
    await action.hover();
    expect(
      ratio(
        await color(action, "color"),
        await color(action, "background-color"),
      ),
      name,
    ).toBeGreaterThanOrEqual(4.5);
  }
  const hoverButton = page.getByRole("button", { name: "普通按钮" });
  await hoverButton.hover();
  expect(
    ratio(
      await color(hoverButton, "color"),
      await color(hoverButton, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    ratio(
      await color(hoverButton, "border-top-color"),
      await color(hoverButton, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(3);
  const input = page.getByRole("textbox", { name: "输入" });
  expect(await color(input, "border-top-color")).toEqual(composerBorder);
  const select = page.getByRole("combobox", { name: "选项" });
  expect(await color(select, "border-top-color")).toEqual(composerBorder);
  for (const id of ["danger", "success", "info"]) {
    const status = page.getByTestId(id);
    expect(
      ratio(
        await color(status, "color"),
        await color(status, "background-color"),
      ),
      id,
    ).toBeGreaterThanOrEqual(4.5);
  }
  const warning = page.getByTestId("warning");
  expect(
    ratio(
      await color(warning, "color"),
      await color(warning, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(4.5);
  const active = page.locator("[data-current-hit=true]");
  expect(
    ratio(
      await color(active, "color"),
      await color(active, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(4.5);
  const code = page.locator(".hljs");
  for (const cls of [".hljs-section", ".hljs-comment"])
    expect(
      ratio(
        await color(code.locator(cls), "color"),
        await color(code, "background-color"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  const chart = page.getByRole("figure", { name: "内存占用折线图" });
  expect(
    ratio(await color(chart.locator("polyline"), "stroke"), bg),
  ).toBeGreaterThanOrEqual(3);
  const disabled = page.getByRole("button", { name: "不可用按钮" });
  await expect(disabled).toBeDisabled();
  const opacity = Number(
    await disabled.evaluate((el) => getComputedStyle(el).opacity),
  );
  expect(opacity).toBeGreaterThanOrEqual(0.7);
  expect(opacity).toBeLessThan(1);
  const disabledText = await color(disabled, "color");
  disabledText[3] *= opacity;
  expect(ratio(blend(disabledText, bg), bg)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus-visible");
  await expect(focused).toBeVisible();
  await expect(focused).toHaveCSS("box-shadow", /rgb\(171, 171, 171\)/);
});

test("warm theme keeps original control and focus values", async ({ page }) => {
  await page.goto("/tests/visual/darkContrastFixture.html?warm");
  await expect(page.getByTestId("surface")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.getByRole("button", { name: "普通按钮" })).toHaveCSS(
    "border-top-color",
    "rgb(211, 211, 211)",
  );
  await expect(page.getByRole("button", { name: "本地边框按钮" })).toHaveCSS(
    "border-top-color",
    "rgb(227, 227, 227)",
  );
  await expect(page.getByRole("button", { name: "不可用按钮" })).toHaveCSS(
    "opacity",
    "0.4",
  );
});

test("real dark usage page preserves readable labels and control boundaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/tests/visual/fixture.html?theme=dark");
  const dialog = page.getByRole("dialog", { name: "设置" });
  const dialogEdge = await color(dialog, "border-top-color");
  expect(dialogEdge).toEqual(parse("rgb(72, 72, 72)"));
  const select = page.getByRole("combobox", { name: "Agent" });
  expect(
    ratio(
      await color(select, "color"),
      await color(select, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(4.5);
  expect(await color(select, "border-top-color")).toEqual(dialogEdge);
  const section = page.getByRole("region", { name: "Token 活动" });
  await expect(section).toBeVisible();
  const cell = section.getByRole("img", { name: /2026年11月12日.*4 轮消息/ });
  expect(
    ratio(
      await color(cell.locator("span").first(), "background-color"),
      await color(section, "background-color"),
    ),
  ).toBeGreaterThanOrEqual(3);
  const mode = section.getByRole("button", { name: "每周" });
  expect(
    ratio(await color(mode, "color"), await color(section, "background-color")),
  ).toBeGreaterThanOrEqual(4.5);
  await mode.click();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  expect(
    ratio(await color(mode, "color"), await color(mode, "background-color")),
  ).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: "node_modules/.cache/dark-contrast-usage.png",
  });
});

test("dark file tree preserves visible labels and keyboard focus", async ({
  page,
}) => {
  await page.goto("/tests/visual/treeMotionFixture.html");
  await page.evaluate(() =>
    document.documentElement.classList.remove("theme-warm"),
  );
  const tree = page.getByRole("tree", { name: "文件" });
  const folder = tree.getByRole("treeitem", { name: /docs/ });
  await expect(folder).toBeVisible();
  const style = await folder.evaluate((el) => ({
    color: getComputedStyle(el).color,
  }));
  expect(
    ratio(parse(style.color), parse("rgb(22, 22, 22)")),
  ).toBeGreaterThanOrEqual(4.5);
  await folder.focus();
  await expect(folder).toBeFocused();
  await folder.click();
  await expect(tree.getByRole("treeitem", { name: /test.ts/ })).toBeVisible();
});
