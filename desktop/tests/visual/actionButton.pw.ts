import { expect, test } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

test("图标按钮的点击区保持六档，字形随字号变化并保留键盘反馈", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/visual/uiScaleFixture.html");
  const feedback = await context.newPage();
  await feedback.setViewportSize({ width: 320, height: 640 });
  await feedback.goto(
    "/tests/visual/uiScaleFixture.html?command-feedback&secondary",
  );
  const region = feedback.getByRole("region", { name: "命令状态" });
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  const specs = [
    ["compact", 24, 14],
    ["standard", 28, 16],
    ["dialog", 32, 16],
    ["rail", 36, 18],
    ["large", 40, 18],
    ["floating", 48, 16],
  ] as const;
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(feedback.locator("html")).toHaveCSS(
      "--ui-font-size",
      `${px}px`,
    );
    const surface = await color(region, "background-color");
    for (const appearance of ["default", "toolbar"]) {
      const group = region.getByRole("group", { name: appearance });
      for (const [name, box, glyph] of specs) {
        const button = group.getByRole("button", { name, exact: true });
        await expect(button).toHaveCSS("width", `${box}px`);
        await expect(button).toHaveCSS("height", `${box}px`);
        await expect
          .poll(async () =>
            parseFloat(
              await button
                .locator("svg")
                .evaluate((el) => getComputedStyle(el).width),
            ),
          )
          .toBeCloseTo((px * glyph) / 14, 1);
        const contrast = async () =>
          ratio(
            await color(button, "color"),
            blend(await color(button, "background-color"), surface),
          );
        await expect.poll(contrast).toBeGreaterThanOrEqual(3);
        await button.hover();
        await expect.poll(contrast).toBeGreaterThanOrEqual(3);
        if (name === "standard") {
          await feedback.mouse.down();
          try {
            await expect(button.locator(".icon-hover-glyph")).toHaveCSS(
              "scale",
              "0.97",
            );
            await expect.poll(contrast).toBeGreaterThanOrEqual(3);
          } finally {
            await feedback.mouse.up();
          }
        }
        await button.press("Shift");
        await expect(button).toBeFocused();
        await expect(button).not.toHaveCSS("box-shadow", "none");
      }
      const disabled = group.getByRole("button", { name: "禁用" });
      await expect(disabled).toBeDisabled();
      await disabled.hover();
      await expect(disabled).toHaveCSS(
        "opacity",
        theme === "暗夜" ? "0.7" : "0.5",
      );
      await expect(disabled).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
  }
  expect(await region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});

test("异步刷新和复制保留键盘焦点并使用主题反馈色", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const feedback = await context.newPage();
  await feedback.setViewportSize({ width: 320, height: 640 });
  await feedback.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText(text: string) {
          if (document.documentElement.dataset.clipboardMode !== "ok")
            return Promise.reject(new Error("剪贴板不可用"));
          document.documentElement.dataset.copied = text;
          return Promise.resolve();
        },
      },
    });
  });
  let requests = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await feedback.route(
    "**/tests/visual/uiScaleFixture.html?sample-refresh",
    async (route) => {
      requests++;
      await pending;
      await route.fulfill({ status: requests === 1 ? 200 : 503 });
    },
  );
  await feedback.goto(
    "/tests/visual/uiScaleFixture.html?command-feedback&secondary",
  );
  const region = feedback.getByRole("region", { name: "命令状态" });
  const refresh = region.getByRole("button", { name: "刷新列表" });
  await refresh.press("Enter");
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await refresh.press("Space");
  await expect.poll(() => requests).toBe(1);
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveCSS("font-size", `${px - 2}px`);
    await expect(refresh).toHaveAttribute("aria-disabled", "true");
    await expect(refresh).not.toHaveCSS("box-shadow", "none");
  }
  finish();
  await expect(refresh).toHaveText("刷新完成");
  await expect(refresh).toBeFocused();
  await expect
    .poll(() => color(refresh.locator("svg"), "color"))
    .toEqual(await color(refresh, "--color-ok-ink"));
  await refresh.press("Enter");
  await expect(refresh).toContainText("读取失败，请重试");
  await expect
    .poll(() => color(refresh.locator("svg"), "color"))
    .toEqual(await color(refresh, "--color-danger-ink"));

  const copy = region.getByRole("button", { name: "复制发布说明" });
  await copy.press("Space");
  await expect(copy).toHaveText("复制失败");
  await expect(copy).toBeFocused();
  await expect
    .poll(() => color(copy, "color"))
    .toEqual(await color(copy, "--color-danger-ink"));
  await feedback.locator("html").evaluate((el) => {
    el.dataset.clipboardMode = "ok";
  });
  await copy.press("Enter");
  await expect(copy).toHaveText("已复制");
  await expect
    .poll(() => color(copy, "color"))
    .toEqual(await color(copy, "--color-ok-ink"));
  await expect(feedback.locator("html")).toHaveAttribute(
    "data-copied",
    "发布前检查通过",
  );
});

test("更新入口切换主题时保留键盘焦点，读得清状态并可打开确认", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const updatePage = await context.newPage();
  await updatePage.goto(
    "/tests/visual/uiScaleFixture.html?update-button&secondary",
  );
  const button = updatePage.getByRole("button", { name: "更新 Desktop" });
  const size = page.getByRole("spinbutton", { name: "界面字号" });
  await button.press("Shift");
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await size.fill(String(px));
    await size.press("Enter");
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("font-size", `${px - 1}px`);
    await expect(button).not.toHaveCSS("box-shadow", "none");
    await expect(button).toHaveCSS("animation-name", "update-button-flow");
    const foreground = await color(button, "color");
    const background = await color(button, "background-color");
    const [r, g, b] = await color(button, "--color-info-ink");
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(foreground, blend([r, g, b, 0.48], background)),
    ).toBeGreaterThanOrEqual(4.5);
  }
  await button.press("Enter");
  await expect(updatePage.locator("html")).toHaveAttribute(
    "data-update-dialog",
    "true",
  );
  await updatePage.emulateMedia({ reducedMotion: "reduce" });
  await expect(button).toHaveCSS("animation-name", "none");
  await expect(button).not.toHaveCSS("box-shadow", "none");
});

for (const theme of ["暖白", "暗夜"]) {
  test(
    theme + " 的共享命令按钮在三档字号下保持点击区、焦点和状态对比度",
    async ({ page }) => {
      await page.goto("/tests/visual/uiScaleFixture.html?actions");
      await page.getByRole("button", { name: theme, exact: true }).click();
      const section = page.getByRole("region", { name: "命令按钮" });
      for (const px of [12, 14, 20]) {
        const size = page.getByRole("spinbutton", { name: "界面字号" });
        await size.fill(String(px));
        await size.press("Enter");
        for (const name of [
          "primary",
          "secondary",
          "ghost",
          "danger",
          "danger-solid",
          "media",
        ]) {
          const button = section.getByRole("button", { name, exact: true });
          const surface = await color(
            section.getByTestId(name + "-surface"),
            "background-color",
          );
          const readable = async () => {
            const bg = blend(await color(button, "background-color"), surface);
            return ratio(blend(await color(button, "color"), bg), bg);
          };
          await page.mouse.move(0, 0);
          await expect(button).toHaveCSS("font-size", px - 2 + "px");
          expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(
            28,
          );
          await expect.poll(readable).toBeGreaterThanOrEqual(4.5);
          await button.hover();
          await page.mouse.down();
          try {
            await expect.poll(readable).toBeGreaterThanOrEqual(4.5);
          } finally {
            await page.mouse.up();
          }
          await expect.poll(readable).toBeGreaterThanOrEqual(4.5);
          await button.press("Space");
          await expect(button).toBeFocused();
          await expect(button).not.toHaveCSS("box-shadow", "none");
          const disabled = section.getByRole("button", {
            name: name + " 禁用",
          });
          await expect(disabled).toBeDisabled();
          const disabledBackground = await color(disabled, "background-color");
          await disabled.hover();
          await expect
            .poll(() => color(disabled, "background-color"))
            .toEqual(disabledBackground);
          await expect(disabled).toHaveCSS(
            "opacity",
            theme === "暗夜" ? "0.7" : "0.4",
          );
        }
      }
    },
  );
}
