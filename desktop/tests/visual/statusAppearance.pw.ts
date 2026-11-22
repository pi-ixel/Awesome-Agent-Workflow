import { expect, test, type Page } from "@playwright/test";
import { blend, color, ratio } from "./contrast.ts";

const preview = "/tests/visual/uiScaleFixture.html?status-controls&secondary";
const appearances = [
  ["暖白", 12],
  ["暗夜", 20],
  ["暖白", 14],
] as const;

async function setAppearance(page: Page, theme: string, px: number) {
  await page.getByRole("button", { name: theme, exact: true }).click();
  const input = page.getByRole("spinbutton", { name: "界面字号" });
  await input.fill(String(px));
  await input.press("Enter");
}

test("状态徽标、安装进度和额度在双主题三档字号下同步，长数值完整显示", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const status = await context.newPage();
  await status.setViewportSize({ width: 300, height: 690 });
  await status.goto(preview);
  const panel = status.getByRole("region", { name: "状态与统计" });
  const badges = [
    ["待执行", "ink-mute", "line-strong"],
    ["运行中", "info-ink", "info-line"],
    ["已完成", "ok-ink", "ok-line"],
    ["等待权限确认", "warn-ink", "warn-line"],
    ["读取失败", "danger-ink", "danger-line"],
  ] as const;
  const limits = [
    ["已用 Credit", "42", "42%", "fill"],
    ["已用存储", "86.5", "86.5%", "warn"],
    ["已用会话额度", "100", "128.4%", "danger"],
  ] as const;
  const progress = panel.getByRole("progressbar", { name: "技能安装进度" });
  const fill = progress.locator(":scope > span");
  const count = panel.getByText("128,400,000,000", { exact: true });
  const chart = panel.getByLabel("内存占用折线图");
  const line = chart.locator("polyline");
  const points = await line.getAttribute("points");
  for (const [theme, px] of appearances) {
    await setAppearance(page, theme, px);
    await expect(panel.getByText("待执行")).toHaveCSS(
      "font-size",
      `${px - 3}px`,
    );
    for (const [label, ink, border] of badges) {
      const badge = panel.getByText(label, { exact: true });
      const dot = badge.locator("[aria-hidden]");
      expect(await color(badge, "color")).toEqual(
        await color(badge, "--color-" + ink),
      );
      expect(await color(badge, "border-top-color")).toEqual(
        await color(badge, "--color-" + border),
      );
      expect((await dot.boundingBox())!.width).toBeCloseTo((6 * px) / 14, 1);
      expect(
        ratio(
          await color(badge, "color"),
          blend(
            await color(badge, "background-color"),
            await color(panel, "background-color"),
          ),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
    const longBadge = panel.getByText(/rollback-verification/);
    expect(
      await longBadge.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(count).toHaveCSS("font-size", `${px + 4}px`);
    expect(await count.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    for (const name of ["消息流清单", "状态卡清单"]) {
      const plan = panel.getByRole("region", { name });
      const complete = plan.getByRole("img", { name: "已完成" }).locator("svg");
      expect((await complete.boundingBox())!.width).toBeCloseTo(
        (12 * px) / 14,
        1,
      );
      await expect(plan.getByRole("status", { name: "进行中" })).toBeVisible();
      await expect(plan.getByRole("img", { name: "待办" })).toBeVisible();
    }
    for (const [name, value, text, tone] of limits) {
      const meter = panel.getByRole("progressbar", { name });
      const fill = meter.locator(":scope > [aria-hidden]");
      await expect(meter).toHaveAttribute("aria-valuenow", value);
      await expect(meter).toHaveAttribute("aria-valuetext", text);
      const background = await color(fill, "background-color");
      expect(background).toEqual(
        await color(fill, "--color-usage-meter-" + tone),
      );
      expect(
        ratio(await color(meter, "color"), background),
      ).toBeGreaterThanOrEqual(4.5);
    }
    await expect(line).toHaveAttribute("points", points!);
    expect(await color(line, "stroke")).toEqual(
      await color(line, "--color-chart-line"),
    );
    expect(
      ratio(
        await color(line, "stroke"),
        await color(chart.getByRole("img"), "background-color"),
      ),
    ).toBeGreaterThanOrEqual(3);
    await expect(chart.getByText(/当前 144.0 MB/)).toHaveCSS(
      "font-size",
      `${px - 2}px`,
    );
    await expect(progress).toHaveAttribute("aria-valuenow", "2");
    const running = await fill.evaluate(
      (el) => getComputedStyle(el).backgroundImage,
    );
    await panel.getByRole("button", { name: "完成安装" }).press("Enter");
    await expect(progress).toHaveAttribute("aria-valuenow", "6");
    await expect(fill).not.toHaveCSS("background-image", running);
    expect(await fill.evaluate((el: HTMLElement) => el.style.width)).toBe(
      "100%",
    );
    await panel.getByRole("button", { name: "重置安装进度" }).press("Enter");
  }
});

test("加载和状态点遵循减少动态效果，键盘阅读中的通知在换肤后保持", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const status = await context.newPage();
  await status.setViewportSize({ width: 320, height: 700 });
  await status.emulateMedia({ reducedMotion: "no-preference" });
  await status.goto(preview);
  const spinner = status
    .getByRole("status", { name: "读取目录" })
    .locator("[aria-hidden]");
  const active = status.getByRole("img", { name: "同步中" });
  const pending = status
    .getByText("运行中", { exact: true })
    .locator("[aria-hidden]");
  await expect(spinner).toHaveCSS("animation-name", "spin");
  await expect(active).toHaveCSS("animation-name", "pulse");
  await expect(pending).toHaveCSS("animation-name", "pulse");
  await status.emulateMedia({ reducedMotion: "reduce" });
  for (const icon of [spinner, active, pending])
    await expect(icon).toHaveCSS("animation-name", "none");
  const trigger = status.getByRole("button", { name: "显示通知" });
  await trigger.press("Enter");
  const toast = status
    .getByRole("status")
    .filter({ hasText: "发布记录已复制" });
  const close = toast.getByRole("button", { name: "关闭提示" });
  await close.focus();
  for (const [theme, px] of appearances) {
    await setAppearance(page, theme, px);
    await expect(toast).toHaveCSS("font-size", `${px - 2}px`);
    expect((await spinner.boundingBox())!.width).toBeCloseTo((16 * px) / 14, 1);
    await expect(close).toBeFocused();
    expect(await toast.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }
  await close.press("Enter");
  await expect(toast).toBeHidden();
});
