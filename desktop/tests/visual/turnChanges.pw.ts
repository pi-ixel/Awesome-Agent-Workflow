import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/tests/visual/turnChanges.html");
  await expect(page.getByText("3 个文件变更", { exact: true })).toBeVisible();
});
test("三态切换保留文件与设置，确认默认取消，成功提示关闭后仍可撤销", async ({
  page,
}) => {
  const dock = page.locator("[data-turn-changes]");
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  await dock.getByRole("button", { name: "放大审阅", exact: true }).click();
  const full = page.getByRole("dialog", { name: "本轮工作区变更审阅" });
  await expect(
    full.getByRole("button", { name: "双栏对比", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await full.getByRole("button", { name: "撤销文件", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "撤销改动" });
  await expect(
    confirm.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).not.toBeVisible();
  await expect(full).toBeVisible();
  await full.getByRole("button", { name: "撤销文件", exact: true }).click();
  await confirm.getByRole("button", { name: "撤销文件", exact: true }).click();
  await expect(
    full.getByRole("button", { name: "恢复", exact: true }),
  ).toBeVisible();
  await full.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(
    full.getByRole("button", { name: "恢复", exact: true }),
  ).toBeVisible();
  await full.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(full.getByText("已恢复改动", { exact: true })).toBeVisible();
});
test("双栏各自横向滚动，拒绝恢复展示中已删除的说明行", async ({ page }) => {
  const dock = page.locator("[data-turn-changes]");
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  await dock.getByRole("button", { name: "换行", exact: true }).click();
  const sides = dock.locator("[data-side]");
  await expect(sides).toHaveCount(2);
  for (const side of await sides.all()) {
    expect(
      await side.evaluate((element) => getComputedStyle(element).overflowX),
    ).toBe("scroll");
  }
  await sides.nth(0).evaluate((element) => {
    element.scrollLeft = 80;
  });
  await expect
    .poll(() => sides.nth(0).evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(await sides.nth(1).evaluate((element) => element.scrollLeft)).toBe(0);
  const previous = await sides.nth(0).evaluate((element) => element.scrollLeft);
  await sides.nth(1).evaluate((element) => {
    element.scrollLeft = 40;
  });
  expect(await sides.nth(0).evaluate((element) => element.scrollLeft)).toBe(
    previous,
  );
  await expect(dock.getByText("统计范围", { exact: true })).toHaveCount(0);
  await expect(dock.getByText("本轮开始", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox").selectOption("newline");
  await expect(
    dock.getByText("\\ 文件末尾无换行", { exact: true }),
  ).toBeVisible();
  const before = dock.locator('[data-side="before"] [data-diff-row]').first();
  const after = dock.locator('[data-side="after"] [data-diff-row]').first();
  expect(
    Math.abs(
      (await before.boundingBox())!.height -
        (await after.boundingBox())!.height,
    ),
  ).toBeLessThan(1);
});
test("还原仍校验文件版本，冲突结果使用持续提示", async ({ page }) => {
  await page.getByRole("combobox").selectOption("conflict");
  await page.getByRole("button", { name: "全部撤销", exact: true }).click();
  await page
    .getByRole("dialog", { name: "撤销改动" })
    .getByRole("button", { name: "撤销文件", exact: true })
    .click();
  await expect(
    page.getByText("文件已有后续修改，整批操作未执行。", { exact: true }),
  ).toBeVisible();
});

test("Diff 唯一入口位于回复末尾，重载后仍能展开", async ({ page }) => {
  await expect(page.getByText("已保存", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看本轮变更", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-composer-dock] [data-turn-changes]"),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-preview-turn=preview-user] [data-turn-changes]"),
  ).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看 Diff", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看 Diff", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销文件", exact: true }),
  ).toBeVisible();
});

for (const mode of [
  "unknown",
  "connection",
  "timeout",
  "runtime",
  "concurrent",
  "snapshot-failed",
]) {
  test(`${mode}：执行状态不阻止还原和撤销，不显示未知或断连条件`, async ({
    page,
  }) => {
    await page.getByRole("combobox").selectOption(mode);
    const dock = page.locator("[data-turn-changes]");
    await expect(
      dock.getByRole("button", { name: "全部撤销", exact: true }),
    ).toBeEnabled();
    await expect(
      dock.getByRole("button", { name: "撤销文件", exact: true }),
    ).toBeEnabled();
    await expect(
      dock.getByText(/结果未知|执行状态未知|确认执行停止|未收到该轮结束确认/),
    ).toHaveCount(0);
    await dock.getByRole("button", { name: "全部撤销", exact: true }).click();
    await page
      .getByRole("dialog", { name: "撤销改动" })
      .getByRole("button", { name: "撤销文件", exact: true })
      .click();
    await expect(
      dock.getByRole("button", { name: "恢复", exact: true }),
    ).toBeEnabled();
    await dock.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(dock.getByText("已恢复改动", { exact: true })).toBeVisible();
  });
}

for (const mode of [
  "zero",
  "missing-baseline",
  "legacy-empty",
  "running",
  "settling",
  "preparing",
]) {
  test(`${mode}：不显示空框、执行中或计算过程`, async ({ page }) => {
    await page.getByRole("combobox").selectOption(mode);
    await expect(page.locator("[data-turn-changes]")).toHaveCount(0);
    await expect(
      page.getByText(/正在准备变更基线|正在核对本轮变更|无法还原本轮历史变更/),
    ).toHaveCount(0);
  });
}
for (const mode of ["partial-large", "legacy-large"]) {
  test(`${mode}：只新增一个文件时总数与默认文件列表严格为 1，采集缺口不混入`, async ({
    page,
  }) => {
    await page.getByRole("combobox").selectOption(mode);
    const dock = page.locator("[data-turn-changes]");
    await expect(dock.getByText("1 个文件变更", { exact: true })).toBeVisible();
    await expect(
      dock.getByRole("button", { name: "全部 (1)", exact: true }),
    ).toBeVisible();
    await expect(
      dock.getByRole("button", { name: "新增 (1)", exact: true }),
    ).toBeVisible();
    await expect(
      dock.getByText("hello.ts", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      dock.getByLabel("本轮文件列表").getByRole("button"),
    ).toHaveCount(1);
    await expect(
      dock.getByLabel("本轮文件列表").getByRole("button").first(),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(dock.getByText(/untouched-|README.md/)).toHaveCount(0);
    await expect(
      dock.getByRole("button", { name: /未统计|待核实/ }),
    ).toHaveCount(0);
    await expect(dock.getByText("不完整", { exact: true })).toHaveCount(0);
    await expect(dock.getByText(/仅统计已确认的本轮变化/)).toHaveCount(0);
    await dock.getByRole("button", { name: "放大审阅", exact: true }).click();
    const full = page.getByRole("dialog", { name: "本轮工作区变更审阅" });
    await expect(
      full.getByRole("button", { name: "全部 (1)", exact: true }),
    ).toBeVisible();
    await expect(
      full.getByLabel("本轮文件列表").getByRole("button"),
    ).toHaveCount(1);
  });
}

test("纯聊天和执行中的新轮保留只读旧卡，新轮结束有变更才移动展示位", async ({
  page,
}) => {
  for (const mode of ["chat-running", "chat-zero"]) {
    await page.getByRole("combobox").selectOption(mode);
    const old = page.locator(
      "[data-preview-turn=preview-user] [data-turn-changes]",
    );
    await expect(old).toHaveCount(1);
    await expect(old.getByText("只读", { exact: true })).toHaveCount(0);
    await expect(
      old.getByRole("button", { name: "全部撤销", exact: true }),
    ).toHaveCount(0);
    await expect(
      old.getByRole("button", { name: "恢复", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-preview-turn=next-user] [data-turn-changes]"),
    ).toHaveCount(0);
  }
  await page.getByRole("combobox").selectOption("next-diff");
  await expect(
    page.locator("[data-preview-turn=preview-user] [data-turn-changes]"),
  ).toHaveCount(0);
  const current = page.locator(
    "[data-preview-turn=next-user] [data-turn-changes]",
  );
  await expect(current).toHaveCount(1);
  await expect(
    current.getByText("1 个文件变更", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "选择变更记录" }),
  ).toHaveCount(0);
});

test("全部撤销后收起并保留恢复，恢复后仍能查看相同历史 Diff", async ({
  page,
}) => {
  await page.getByRole("button", { name: "全部撤销", exact: true }).click();
  await page
    .getByRole("dialog", { name: "撤销改动" })
    .getByRole("button", { name: "撤销文件", exact: true })
    .click();
  const card = page.locator("[data-turn-changes]");
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-turn-diff-body]")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "恢复", exact: true }),
  ).toBeEnabled();
  await card.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(card.getByText("已恢复改动", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "查看 Diff", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "全部 (3)", exact: true }),
  ).toBeVisible();
});

test("内嵌高度与字号固定，卡片宽度跟随正文，窗口变化只改变布局", async ({
  page,
}) => {
  const card = page.locator("[data-turn-changes]");
  const body = card.locator("[data-turn-diff-body]");
  const height = (await body.boundingBox())!.height;
  expect(
    await card.evaluate((element) => getComputedStyle(element).borderRadius),
  ).toBe("16px");
  const fontSize = await card
    .locator("[data-turn-changes-title]")
    .evaluate((el) => getComputedStyle(el).fontSize);
  for (const width of [480, 760, 1200]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(body).toBeVisible();
    expect((await body.boundingBox())!.height).toBe(height);
    expect(
      await card
        .locator("[data-turn-changes-title]")
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe(fontSize);
    expect(
      Math.abs(
        (await card.boundingBox())!.width -
          (await page.locator("[data-chat-content]").boundingBox())!.width,
      ),
    ).toBeLessThan(1);
  }
});
