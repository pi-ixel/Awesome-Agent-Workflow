import { expect, test, type Locator } from "@playwright/test";

const rangeCenter = (code: Locator, end: number) =>
  code.evaluate((element, last) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 12);
    range.setEnd(element.firstChild!, last);
    const rect = range.getClientRects()[0]!;
    const viewport = element.closest(".overflow-auto")!;
    const left = Math.max(
      rect.left,
      element.previousElementSibling!.getBoundingClientRect().right,
    );
    const right = Math.min(rect.right, viewport.getBoundingClientRect().right);
    return { x: (left + right) / 2, y: rect.top };
  }, end);

test("长日志和旧 Git Diff 默认换行，可切回横向滚动", async ({ page }) => {
  await page.goto("/tests/visual/fileWrapFixture.html");
  const log = page.getByRole("region", { name: "日志预览" });
  const first = log.locator("[data-file-line='1'] code");
  const legacy = page.getByLabel("Git 统一差异");
  const patch = legacy.locator("code").filter({ hasText: /0123456789/ });
  const sideways = (code: Locator) =>
    code.evaluate((element) => {
      const viewport = element.closest(".overflow-auto")!;
      return viewport.scrollWidth - viewport.clientWidth;
    });
  for (const code of [first, patch]) {
    await expect(code).toHaveCSS("white-space", "pre-wrap");
    expect(await sideways(code)).toBe(0);
    expect((await code.boundingBox())!.height).toBeGreaterThan(65);
  }
  await expect(log.locator("[data-file-line]")).toHaveCount(2);
  await log.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitemradio", { name: "自动换行" }).click();
  await page
    .getByRole("region", { name: "旧 Git 差异预览" })
    .getByRole("button", { name: "换行", exact: true })
    .click();
  for (const code of [first, patch]) {
    await expect(code).toHaveCSS("white-space", "pre");
    expect(await sideways(code)).toBeGreaterThan(500);
  }
});

test("批注根据日志可见首行对齐，横向滚动后重算并保留已输入的意见", async ({
  page,
}) => {
  await page.goto("/tests/visual/fileWrapFixture.html");
  const log = page.getByRole("region", { name: "日志预览" });
  const code = log.locator("[data-file-line='1'] code");
  await expect(code).toBeVisible();
  const select = (end: number) =>
    code.evaluate((element, last) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 12);
      range.setEnd(element.firstChild!, last);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }, end);
  const popup = page.getByRole("group", { name: "选区操作" });
  const editor = page.getByRole("dialog", { name: "文档批注" });
  const expectAligned = async (anchor: { x: number; y: number }) => {
    await expect
      .poll(async () =>
        popup.evaluate((element, expected) => {
          const box = element.getBoundingClientRect();
          return (
            Math.abs(box.x + box.width / 2 - expected.x) +
            Math.abs(box.bottom - (expected.y - 6))
          );
        }, anchor),
      )
      .toBeLessThan(2);
  };
  await select(90);
  await expectAligned(await rangeCenter(code, 90));
  await popup.getByRole("button", { name: "批注", exact: true }).click();
  await expect(editor.getByText("第 1 行")).toBeVisible();
  await expect(editor.locator("blockquote")).toHaveText(
    "0123456789".repeat(24).slice(12, 90),
  );
  await page.keyboard.press("Escape");

  await log.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitemradio", { name: "自动换行" }).click();
  await expect(code).toHaveCSS("white-space", "pre");
  await select(55);
  await expectAligned(await rangeCenter(code, 55));
  await code.evaluate((element) => {
    element.closest(".overflow-auto")!.scrollLeft = 85;
  });
  await expectAligned(await rangeCenter(code, 55));
  await popup.getByRole("button", { name: "批注", exact: true }).click();
  const input = editor.getByRole("textbox", { name: "批注意见" });
  await input.fill("保留本行线索");
  await code.evaluate((element) => {
    element.closest(".overflow-auto")!.scrollLeft = 150;
  });
  const moved = await rangeCenter(code, 55);
  await expect
    .poll(async () =>
      editor.evaluate((element, center) => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.x + box.width / 2 - center);
      }, moved.x),
    )
    .toBeLessThan(2);
  await code.evaluate((element) => {
    element.closest(".overflow-auto")!.scrollLeft = 1200;
  });
  await expect(input).toHaveValue("保留本行线索");
});
