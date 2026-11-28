import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/tests/visual/turnChanges.html");
  await expect(page.getByText("3 个文件变更", { exact: true })).toBeVisible();
});
test("折叠时展示历史摘要，展开后按轮读取正文", async ({ page }) => {
  await page.goto("/tests/visual/turnChanges.html?deferred-details");
  const dock = page.locator("[data-turn-changes]");
  await expect(dock.getByText("3 个文件变更", { exact: true })).toBeVisible();
  await expect(dock.locator("[data-diff-row]")).toHaveCount(0);
  await dock.getByRole("button", { name: "查看 Diff", exact: true }).click();
  await expect(dock.locator("[data-diff-row]").first()).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "收起", exact: true }),
  ).toBeVisible();
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
  const rightOffset = await sides
    .nth(1)
    .evaluate((element) => element.scrollLeft);
  expect(rightOffset).toBeGreaterThan(0);
  await dock.getByRole("button", { name: "统一视图", exact: true }).click();
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  expect(await sides.nth(0).evaluate((element) => element.scrollLeft)).toBe(
    previous,
  );
  expect(await sides.nth(1).evaluate((element) => element.scrollLeft)).toBe(
    rightOffset,
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

test("大文件只挂载可见差异，切换视角保留代码行并可直接滚到文件末尾", async ({
  page,
}) => {
  await page.goto("/tests/visual/turnChanges.html?large-diff");
  const dock = page.locator("[data-turn-changes]");
  const unified = dock.getByLabel("统一差异", { exact: true });
  const before = dock.locator('[data-side="before"]');
  const after = dock.locator('[data-side="after"]');
  const topNewLine = (pane: typeof unified) =>
    pane.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      return (
        Array.from(
          element.querySelectorAll<HTMLElement>("[data-diff-row]"),
        ).find((row) => row.getBoundingClientRect().bottom > top + 1)?.dataset
          .diffNewLine ?? null
      );
    });

  await expect(unified.locator("[data-diff-row]").first()).toBeVisible();
  expect(await unified.locator("[data-diff-row]").count()).toBeLessThan(100);
  await unified.evaluate((element) => {
    element.scrollTop = element.scrollHeight * 0.7;
  });
  await expect.poll(() => topNewLine(unified)).not.toBeNull();
  const line = await topNewLine(unified);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const layoutCount = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      ({ name }) => name === "LayoutCount",
    )!.value;
  const layoutBefore = await layoutCount();
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  await expect.poll(() => topNewLine(after)).toBe(line);
  expect((await layoutCount()) - layoutBefore).toBeLessThan(60);
  await cdp.detach();
  expect(await dock.locator("[data-diff-row]").count()).toBeLessThan(120);
  const aligned = await before.evaluate((element) => {
    const left = Array.from(element.querySelectorAll("[data-diff-row]"));
    const right = Array.from(
      element.parentElement!.querySelectorAll(
        '[data-side="after"] [data-diff-row]',
      ),
    );
    return (
      left.length > 0 &&
      left.length === right.length &&
      left.every((row, index) => {
        const peer = right[index]!;
        return (
          row.getAttribute("data-diff-index") ===
            peer.getAttribute("data-diff-index") &&
          Math.abs(
            row.getBoundingClientRect().height -
              peer.getBoundingClientRect().height,
          ) < 0.5
        );
      })
    );
  });
  expect(aligned).toBe(true);

  await dock.getByRole("button", { name: "统一视图", exact: true }).click();
  await expect.poll(() => topNewLine(unified)).toBe(line);
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  await after.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(after.getByText(/^after-1100 /)).toBeInViewport();
  await expect(
    after.getByText("\\ 文件末尾无换行", { exact: true }),
  ).toBeInViewport();
  await expect
    .poll(async () =>
      Math.abs(
        (await before.evaluate((el) => el.scrollTop)) -
          (await after.evaluate((el) => el.scrollTop)),
      ),
    )
    .toBeLessThan(1);
  await expect(dock.getByRole("button", { name: /显示更多差异/ })).toHaveCount(
    0,
  );
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

test("纯聊天、执行中的新轮及完成后的新轮都保留只读旧卡", async ({ page }) => {
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
  ).toHaveCount(1);
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

test("删除行和片段批注保存到会话草稿，回跳准确区分修改前与片段", async ({
  page,
}) => {
  await page.goto("/tests/visual/turnChanges.html?annotations");
  const dock = page.locator("[data-turn-changes]");
  await dock.getByRole("button", { name: /tools\.legacy\.json/ }).click();
  const oldLine = dock.getByRole("button", { name: "批注修改前 · 第 2 行" });
  await oldLine.hover();
  await expect(oldLine).toHaveCSS("opacity", "1");
  await oldLine.click();
  const editor = page.getByRole("dialog", { name: "文档批注" });
  await expect(editor.getByText('"systemBrowserFallback": true')).toBeVisible();
  await editor
    .getByRole("textbox", { name: "批注意见" })
    .fill("确认删除系统浏览器回退。");
  await editor.getByRole("button", { name: "添加到会话" }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    dock.getByRole("button", { name: "收起", exact: true }),
  ).toBeVisible();
  const card = page.getByRole("button", {
    name: /tools\.legacy\.json.*修改前.*第 2 行/,
  });
  await card.click();
  const review = page.getByRole("dialog", { name: "批注原 Diff" });
  await expect(
    review.locator('[data-side="before"] [data-diff-annotation-location]'),
  ).toContainText("systemBrowserFallback");
  await expect(
    review.locator('[data-side="after"] [data-diff-annotation-location]'),
  ).toHaveCount(0);
  await review.getByRole("button", { name: "关闭差异" }).click();
  await page.reload();
  await expect(card).toBeVisible();

  await page.goto(
    "/tests/visual/turnChanges.html?annotations&journal-fragments",
  );
  await card.click();
  await expect(
    page.getByText("原差异版本不可用，以下是批注保存时的内容。"),
  ).toBeVisible();
  await expect(page.getByText("确认删除系统浏览器回退。")).toBeVisible();
  const fragment = page.getByRole("button", {
    name: "批注修改后 · 片段 2，第 1 行",
  });
  await fragment.focus();
  await fragment.press("Enter");
  await expect(editor.getByText("second-new")).toBeVisible();
  await editor.getByRole("textbox", { name: "批注意见" }).fill("第二处调整");
  await editor.getByRole("button", { name: "添加到会话" }).click();
  await page
    .getByRole("button", { name: /systemFallback.ts.*片段 2，第 1 行/ })
    .click();
  await expect(review.locator("[data-diff-annotation-location]")).toContainText(
    "second-new",
  );
});

test("锁定的历史 Diff 可批注，跨栏选区无批注入口", async ({ page }) => {
  await page.goto("/tests/visual/turnChanges.html?annotations");
  await page.getByRole("combobox").selectOption("next-diff");
  const history = page.locator(
    "[data-preview-turn=preview-user] [data-turn-changes]",
  );
  await expect(history.getByRole("button", { name: "全部撤销" })).toHaveCount(
    0,
  );
  if (await history.getByRole("button", { name: "查看 Diff" }).count())
    await history.getByRole("button", { name: "查看 Diff" }).click();
  await history.getByRole("button", { name: "双栏对比" }).click();
  const pick = (old: boolean) =>
    page.evaluate((crossColumn) => {
      const root = document.querySelector("[data-preview-turn=preview-user]")!;
      const first = root.querySelector(
        "[data-annotation-old='1']",
      )!.firstChild!;
      const last = root.querySelector(
        crossColumn ? "[data-annotation-new='3']" : "[data-annotation-old='2']",
      )!.firstChild!;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent!.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      last.parentElement!.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true }),
      );
    }, old);
  await pick(true);
  await expect(
    page.getByRole("button", { name: "批注", exact: true }),
  ).toHaveCount(0);
  await pick(false);
  await page.getByRole("button", { name: "批注", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "文档批注" });
  await expect(editor.getByText(/修改前 · 第 1–2 行/)).toBeVisible();
  await editor
    .getByRole("textbox", { name: "批注意见" })
    .fill("保留旧实现的校验。");
  await editor.getByRole("button", { name: "添加到会话" }).click();
  await page
    .getByRole("button", { name: /systemFallback.ts.*修改前.*第 1–2 行/ })
    .click();
  const review = page.getByRole("dialog", { name: "批注原 Diff" });
  await expect(review.locator("[data-diff-annotation-location]")).toHaveCount(
    2,
  );
});

test("放大审阅复用同一浮层，支持仅引用及原地编辑和删除", async ({ page }) => {
  await page.goto("/tests/visual/turnChanges.html?annotations");
  await page.getByRole("button", { name: "放大审阅", exact: true }).click();
  const review = page.getByRole("dialog", { name: "本轮工作区变更审阅" });
  const add = review.getByRole("button", {
    name: "批注修改前 · 第 2 行",
    exact: true,
  });
  await add.click();
  const editor = review.getByRole("dialog", { name: "文档批注" });
  const input = editor.getByRole("textbox", { name: "批注意见" });
  await expect(editor).toHaveAttribute("data-hint-open", "true");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute(
    "placeholder",
    "写下意见，或留空仅引用原文",
  );
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(review).toBeVisible();

  await add.click();
  await input.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect(review).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights.keys()).some((key) =>
          key.startsWith("diff-annotation-"),
        ),
      ),
    )
    .toBe(true);
  const code = review.locator("[data-annotation-old='2']");
  await code.click({ position: { x: 20, y: 5 } });
  await expect(
    editor.getByRole("button", { name: "删除", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("在原审阅中补充意见");
  await editor.getByRole("button", { name: "添加到会话" }).click();
  await expect(editor).toHaveCount(0);
  await code.click({ position: { x: 20, y: 5 } });
  await expect(input).toHaveValue("在原审阅中补充意见");
  await editor.getByRole("button", { name: "删除", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "关闭放大审阅" }).click();
  await expect(page.getByLabel("文档批注")).toHaveCount(0);
});

test("批注操作跟随鼠标松开点，反向拖选和窗口边缘都能继续操作", async ({
  page,
}) => {
  await page.goto("/tests/visual/turnChanges.html?annotations");
  const code = page.locator("[data-annotation-new='1']");
  await expect(code).toBeVisible();
  const bounds = (await code.boundingBox())!;
  const { x, y: top, width, height } = bounds;
  const left = Math.round(x + 12);
  const right = Math.round(x + Math.min(160, width - 8));
  const y = Math.round(top + height / 2);
  const actions = page.getByRole("group", { name: "选区操作" });
  for (const [start, end] of [
    [left, right],
    [right, left],
  ] as const) {
    await page.mouse.move(start, y);
    await page.mouse.down();
    await page.mouse.move(end, y, { steps: 8 });
    await page.mouse.up();
    await expect(actions).toHaveCSS("left", `${end}px`);
    await expect(actions).toHaveCSS("top", `${y + 6}px`);
    await actions.getByRole("button", { name: "批注", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "文档批注" });
    await expect(editor).toHaveCSS("left", `${end}px`);
    await expect(editor).toHaveCSS("top", `${y + 6}px`);
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  }

  await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: window.innerWidth - 10,
        clientY: window.innerHeight - 20,
      }),
    );
  });
  await actions.getByRole("button", { name: "批注", exact: true }).click();
  const edge = (await page
    .getByRole("dialog", { name: "文档批注" })
    .boundingBox())!;
  expect(edge.x + edge.width).toBeLessThanOrEqual(992);
  expect(edge.y + edge.height).toBeLessThanOrEqual(774);
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

test("已核验的日志片段支持双栏预览，缺少完整版本时文件只读", async ({
  page,
}) => {
  await page.goto("/tests/visual/turnChanges.html?journal-fragments");
  const dock = page.locator("[data-turn-changes]");
  await expect(dock.getByText("first-new", { exact: true })).toBeVisible();
  await dock.getByRole("button", { name: "双栏对比", exact: true }).click();
  await expect(dock.getByText("second-old", { exact: true })).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "撤销文件", exact: true }),
  ).toBeDisabled();
});
