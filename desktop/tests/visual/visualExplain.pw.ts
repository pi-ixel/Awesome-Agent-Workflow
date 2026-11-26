import { expect, test, type Page } from "@playwright/test";

const fixture = "/tests/visual/visualExplainFixture.html";

function figure(page: Page, message: number) {
  return page.locator(`[data-message="${message}"] figure[data-visual]`);
}

test("讲解图按内容分流：套件与静态 HTML/SVG 走内联，含脚本的进沙箱", async ({
  page,
}) => {
  await page.setViewportSize({ width: 860, height: 900 });
  await page.goto(fixture);
  const modes = await page
    .locator("figure[data-visual] [data-visual-mode]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-visual-mode")),
    );
  // storage, virtualization, tabs, steps, svg, script, table, error, crowded
  expect(modes).toEqual([
    "inline",
    "inline",
    "inline",
    "inline",
    "inline",
    "frame",
    "inline",
    "frame",
    "inline",
  ]);
  await expect(figure(page, 0).locator("v-box .v-head").first()).toHaveText(
    "我们的存储系统",
  );
  await expect(figure(page, 0).locator("v-grid v-icon")).toHaveCount(12);
});

test("套件交互在内联路径可用：标签页与分步演示", async ({ page }) => {
  await page.goto(fixture);
  const tabs = figure(page, 2);
  await expect(tabs.getByText("可还原到具体文档")).toBeVisible();
  await tabs.getByRole("tab", { name: "虚拟化存储" }).click();
  await expect(tabs.getByText("看不到盘内文件")).toBeVisible();
  await expect(tabs.getByText("可还原到具体文档")).toBeHidden();

  const steps = figure(page, 3);
  await expect(steps.locator(".v-step-label")).toHaveText("1 / 3 · 收集");
  await steps.getByRole("button", { name: "下一步" }).click();
  await steps.getByRole("button", { name: "下一步" }).click();
  await expect(steps.locator(".v-step-label")).toHaveText("3 / 3 · 外传");
  await expect(steps.getByRole("button", { name: "下一步" })).toBeDisabled();
});

test("沙箱讲解图执行脚本、自适应高度、报错有提示、换肤不重载", async ({
  page,
}) => {
  await page.goto(fixture);
  const host = figure(page, 5);
  await host.scrollIntoViewIfNeeded();
  const frame = host.frameLocator("iframe");
  await expect(frame.locator("#packed")).toHaveText("48.0 GB");
  await frame.locator("#ratio").fill("80");
  await expect(frame.locator("#packed")).toHaveText("24.0 GB");
  await expect
    .poll(() =>
      host
        .locator("iframe")
        .evaluate((el) => el.getBoundingClientRect().height),
    )
    .toBeGreaterThan(150);

  const title = frame.locator("v-box .v-title").first();
  const warmColor = await title.evaluate((el) => getComputedStyle(el).color);
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect
    .poll(() => title.evaluate((el) => getComputedStyle(el).color))
    .not.toBe(warmColor);
  // 换肤经消息推送，脚本状态仍在
  await expect(frame.locator("#packed")).toHaveText("24.0 GB");

  const broken = figure(page, 7);
  await broken.scrollIntoViewIfNeeded();
  await expect(broken.getByLabel(/^脚本出错：/)).toBeVisible();
});

test("窄宽度下横排自动改竖排，箭头转向", async ({ page }) => {
  await page.goto(`${fixture}?only=storage&width=360`);
  const row = figure(page, 0).locator("v-row").first();
  await expect(row).toHaveCSS("flex-direction", "column");
  // 改竖排后换成竖向字形（不旋转），横向字形隐藏
  const arrow = row.locator(":scope > v-arrow").first();
  await expect(arrow.locator(".v-v")).toBeVisible();
  await expect(arrow.locator(".v-h")).toBeHidden();
});

test("横排按内容估算是否放得下：两栏保持横排，三栏带条目和长标签时改竖排", async ({
  page,
}) => {
  await page.setViewportSize({ width: 860, height: 900 });
  await page.goto(fixture);
  await expect(figure(page, 0).locator("v-row").first()).toHaveCSS(
    "flex-direction",
    "row",
  );
  // 内联图离屏时不布局（content-visibility），滚进视口才做判断
  await figure(page, 8).scrollIntoViewIfNeeded();
  const crowded = figure(page, 8).locator("v-row").first();
  await expect(crowded).toHaveAttribute("data-stack");
  await expect(crowded).toHaveCSS("flex-direction", "column");
  // 不出现单词被拆开：每个条目标题都在一行内放下
  const wrapped = await crowded
    .locator("v-item .v-title")
    .evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) =>
            node.scrollWidth > node.clientWidth + 1 ||
            node.getClientRects().length > 1,
        ).length,
    );
  expect(wrapped).toBe(0);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${fixture}?only=crowded&width=1200`);
  await expect(figure(page, 0).locator("v-row").first()).toHaveCSS(
    "flex-direction",
    "row",
  );
});

test("80 条讲解图消息：挂载与基线持平、滚动无长任务、离屏 iframe 被释放且高度不跳", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 900, height: 900 });
  const mount = async (query: string) => {
    await page.goto(`${fixture}?${query}`);
    await page.waitForFunction(
      () => typeof window.__visualMountedAt === "number",
    );
    return page.evaluate(() => window.__visualMountedAt);
  };
  const plain = await mount("perf=80&plain");
  const visual = await mount("perf=80");
  expect(visual).toBeLessThan(plain * 1.5 + 100);

  await page.evaluate(() => {
    const store: number[] = [];
    (window as unknown as { __long: number[] }).__long = store;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.push(entry.duration);
    }).observe({ type: "longtask" });
  });
  const count = await page.locator("[data-message]").count();
  for (let index = 0; index < count; index += 2) {
    await page
      .locator(`[data-message="${index}"]`)
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(30);
  }
  const longTasks = await page.evaluate(
    () => (window as unknown as { __long: number[] }).__long,
  );
  expect(Math.max(0, ...longTasks)).toBeLessThan(120);
  expect(await page.locator("iframe").count()).toBeGreaterThan(10);

  // 目标先完整挂载一次，记下稳定高度
  const target = figure(page, 5);
  const height = () =>
    target.evaluate((el) => el.getBoundingClientRect().height);
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(target.frameLocator("iframe").locator("#packed")).toHaveText(
    "48.0 GB",
  );
  await page.waitForTimeout(300);
  const settled = await height();

  await page
    .locator(`[data-message="${count - 1}"]`)
    .evaluate((el) => el.scrollIntoView());
  await expect
    .poll(() => page.locator("iframe").count(), { timeout: 20_000 })
    .toBeLessThanOrEqual(4);
  await expect(target.locator("iframe")).toHaveCount(0);
  expect(await height()).toBe(settled);

  // 滚回：重建 iframe 的全过程高度都不变
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const samples: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    samples.push(await height());
    await page.waitForTimeout(50);
  }
  await expect(target.locator("iframe")).toHaveCount(1);
  expect(new Set(samples)).toEqual(new Set([settled]));
});
