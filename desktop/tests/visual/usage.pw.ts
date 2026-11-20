import { expect, test, type Locator } from "@playwright/test";

async function bounds(element: Locator) {
  await expect(element).toBeVisible();
  return (await element.boundingBox())!;
}

test("two ACP substitutes feed the page and an IndexedDB write survives a browser reload", async ({
  page,
}) => {
  await page.goto("/tests/visual/fixture.html?protocol");
  const total = page.locator('dl[aria-label="累计统计"] dd').first();
  await expect(total).toHaveText("0");
  await page.getByRole("button", { name: "完成 iCode 轮次" }).click();
  await expect(page.getByRole("alert")).toContainText("disk full");
  await expect(total).toHaveText("0");
  await page.reload();
  await expect(total).toHaveText("120");
  await page.getByRole("button", { name: "完成 CodeAgent 轮次" }).click();
  await expect(total).toHaveText("620");
  await page.getByRole("button", { name: "清除会话视图" }).click();
  await expect(total).toHaveText("620");
  await page.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "CodeAgent" }).click();
  await expect(total).toHaveText("500");
});

test("white cards, compact title filter, evenly spaced full months and keyboard tooltip", async ({
  page,
  context,
}) => {
  const settings = await context.newPage();
  await settings.goto("/tests/visual/uiScaleFixture.html");
  await settings.getByRole("button", { name: "暖白", exact: true }).click();
  await page.setViewportSize({ width: 1400, height: 1060 });
  await page.goto("/tests/visual/fixture.html?appearance");
  const title = page.getByRole("heading", { name: "使用统计", exact: true });
  const tab = page
    .getByRole("group", { name: "数据与统计" })
    .getByRole("tab", { name: "使用统计" });
  await expect(tab.locator("svg path")).toHaveAttribute("d", /M8 17v-3/);
  const agent = page.getByRole("combobox", { name: "Agent" });
  await expect(title).toHaveClass("sr-only");
  const heading = await bounds(page.getByRole("group", { name: "设置操作" }));
  const filter = await bounds(agent);
  expect(
    Math.abs(heading.y + heading.height / 2 - filter.y - filter.height / 2),
  ).toBeLessThan(3);
  expect(filter.width).toBeLessThan(180);
  await expect(
    page.getByText(/统计时区|暂无轮次记录|每日明细|按所选模型统计|全部工作区/),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复默认设置" })).toHaveCount(
    0,
  );
  const heatmap = page.getByRole("region", { name: "Token 活动" });
  await expect(heatmap).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const card = page.locator('dl[aria-label="累计统计"]').locator("..");
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const lines = card.locator('span[aria-hidden="true"]');
  await expect(lines).toHaveCount(3);
  await expect(lines.first()).toHaveCSS("width", "1px");
  await expect(lines.first()).toHaveCSS("height", "28px");
  const months = heatmap.getByLabel("最近十二个月").locator("span");
  await expect(months).toHaveCount(12);
  const positions = await months.evaluateAll((elements) =>
    elements.map((el) => {
      const { x, width } = el.getBoundingClientRect();
      return x + width / 2;
    }),
  );
  const gaps = positions.slice(1).map((x, i) => x - positions[i]!);
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(10);
  await expect(months.last()).toHaveText("11月");
  await agent.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭设置" })).toBeFocused();
  const cell = heatmap.getByRole("img", { name: /2026年11月12日.*4 轮消息/ });
  await cell.focus();
  await expect(page.getByRole("tooltip")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.getByRole("tooltip")).toContainText("4 轮消息");
  const trend = page.getByRole("region", { name: "每日 Token 趋势图" });
  const daily = heatmap.getByRole("button", { name: "每日" });
  const week = trend.getByRole("button", { name: "近 7 天" });
  for (const property of ["background-color", "border-radius", "font-size", "height"]) {
    const reference = await week.evaluate((element, property) =>
      getComputedStyle(element).getPropertyValue(property), property);
    await expect(daily).toHaveCSS(property, reference);
  }
  const range = await bounds(trend.getByRole("button", { name: "近 30 天" }));
  const plot = await bounds(trend.getByRole("img"));
  expect(range.y + range.height).toBeLessThan(plot.y);
  expect(range.x).toBeGreaterThan(plot.x + plot.width / 2);
  const canvas = trend.locator("canvas");
  const hasSeriesPixels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const token = getComputedStyle(element).getPropertyValue("--color-usage-series-1").trim();
    const probe = document.createElement("canvas").getContext("2d")!;
    probe.fillStyle = token;
    probe.fillRect(0, 0, 1, 1);
    const expected = probe.getImageData(0, 0, 1, 1).data;
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === expected[0] && pixels[i + 1] === expected[1] &&
          pixels[i + 2] === expected[2] && pixels[i + 3]! > 200) return true;
    }
    return false;
  });
  const warm = await canvas.evaluate(el => getComputedStyle(el).getPropertyValue("--color-usage-series-1"));
  await expect.poll(hasSeriesPixels).toBe(true);
  await cell.focus();
  const cellColor = await cell.locator("span[aria-hidden=true]").evaluate((el) => getComputedStyle(el).backgroundColor);
  await settings.getByRole("button", { name: "暗夜", exact: true }).click();
  await expect(canvas).not.toHaveCSS("--color-usage-series-1", warm);
  await expect(cell.locator("span[aria-hidden=true]")).not.toHaveCSS("background-color", cellColor);
  await expect(cell).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("4 轮消息");
  await expect.poll(hasSeriesPixels).toBe(true);
  await settings.getByRole("button", { name: "暖白", exact: true }).click();
  await expect(cell.locator("span[aria-hidden=true]")).toHaveCSS("background-color", cellColor);
  await expect(cell).toBeFocused();
  await expect.poll(hasSeriesPixels).toBe(true);
});

test("U09 renders an aggregated payload with bounded client work", async ({
  page,
}) => {
  await page.goto("/tests/visual/fixture.html?scale");
  await expect(
    page.getByRole("region", { name: "每日 Token 趋势图" }),
  ).toBeVisible();
  const sample = await page.evaluate(() => {
    const mount = performance.getEntriesByName("usage-fixture-mount")[0]!
      .startTime;
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize: number } }
    ).memory;
    return {
      renderMs: Math.round(performance.now() - mount),
      heapBytes: memory?.usedJSHeapSize ?? null,
    };
  });
  console.log("aggregated usage browser sample", sample);
  expect(sample.renderMs).toBeLessThan(2500);
});

test("narrow dark settings and white storage/diagnostics cards fit their panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 950 });
  await page.goto("/tests/visual/fixture.html?theme=dark");
  const heatmap = page.getByRole("region", { name: "Token 活动" });
  await expect(heatmap).toHaveCSS("background-color", "rgb(43, 43, 43)");
  for (const region of [
    heatmap,
    page.getByRole("region", { name: "模型用量" }),
  ]) {
    await expect(region).toBeVisible();
    expect(
      await region.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto("/tests/visual/fixture.html");
  await page.getByRole("tab", { name: "存储" }).click();
  const overview = page.locator('dl[aria-label="存储概览"]').locator("..");
  await expect(overview).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const refresh = await bounds(page.getByRole("button", { name: "刷新" }));
  const project = await bounds(page.getByRole("combobox", { name: "项目" }));
  expect(Math.abs(refresh.y - project.y)).toBeLessThan(2);
  await expect(page.getByText("操作", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "诊断日志", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "诊断日志", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.goto("/tests/visual/fixture.html?diagnostics");
  const load = page.locator('dl[aria-label="连接负载"]').locator("../..");
  await expect(load).toHaveCSS("background-color", "rgb(255, 255, 255)");
});
