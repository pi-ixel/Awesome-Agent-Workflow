import { expect, test } from "@playwright/test";

test("archived session deletion confirms once, preserves a failed row, and can retry", async ({
  page,
}) => {
  await page.goto("/tests/visual/sessionDeletionFixture.html");
  const remove = page.getByRole("button", { name: "彻底删除 测试会话" });
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "彻底删除会话" });
  await expect(dialog).toContainText("历史用量统计保留");
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "测试会话", exact: true }),
  ).toBeEnabled();
  await remove.click();
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("文件被占用");
  await expect(
    page.getByRole("button", { name: "测试会话", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "取消归档 测试会话" }),
  ).toBeDisabled();
  await remove.click();
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(page.getByText("暂无归档会话。")).toBeVisible();
});

test("批量删除显示项目范围、进度和可重试的部分失败", async ({ page }) => {
  await page.goto("/tests/visual/sessionDeletionDemo.html?theme=light");
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("searchbox").fill("Awesome-Agent-Workflow");
  await settings.getByRole("button", { name: "批量选择" }).press("Enter");
  const selectAll = settings.getByRole("checkbox", {
    name: "全选当前筛选结果",
  });
  await page.keyboard.press("Tab");
  await expect(selectAll).toBeFocused();
  await page.keyboard.press("Space");
  await expect(settings.getByText("已选 3 条")).toBeVisible();
  const remove = settings.getByRole("button", { name: "彻底删除所选" });
  await remove.press("Enter");
  const confirm = page.getByRole("dialog", { name: "批量彻底删除会话" });
  await expect(confirm).toContainText("D:/program/Awesome-Agent-Workflow");
  await expect(confirm).not.toContainText("D:/projects/order-service");
  await expect(confirm.getByRole("button", { name: "取消" })).toBeFocused();
  await confirm.press("Escape");
  await expect(remove).toBeFocused();
  await remove.press("Enter");
  await confirm.getByRole("button", { name: "彻底删除 3 条" }).click();
  await expect(settings.getByText(/正在删除（/)).toBeVisible();
  await expect(settings.getByRole("searchbox")).toBeFocused();
  await expect(
    settings.getByText("批量删除结束 · 成功 1 条 · 失败 2 条"),
  ).toBeVisible();
  await expect(settings.getByText(/历史已删除，本地清理未完成/)).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "彻底删除 修复归档会话的标题丢失" }),
  ).toHaveText("重试删除");
  await settings.getByRole("button", { name: "切换明暗" }).click();
  await expect(
    settings.getByText("批量删除结束 · 成功 1 条 · 失败 2 条"),
  ).toBeVisible();
  await settings.getByRole("searchbox").clear();
  await expect(
    settings.getByRole("button", {
      name: "修复订单重试导致的重复扣款",
      exact: true,
    }),
  ).toBeEnabled();
});

test("归档管理在窄栏换肤时保留展开和焦点，恢复会话后可继续键盘操作", async ({
  page,
  context,
}) => {
  await page.goto("/tests/visual/uiScaleFixture.html");
  const archive = await context.newPage();
  await archive.emulateMedia({ reducedMotion: "reduce" });
  await archive.setViewportSize({ width: 320, height: 720 });
  await archive.goto(
    "/tests/visual/sessionDeletionFixture.html?navigation&appearance",
  );
  const release = archive.getByRole("button", { name: "归档项目 D:/release" });
  await release.press("Enter");
  await expect(release).toHaveAttribute("aria-expanded", "false");
  const group = archive.getByRole("button", { name: "归档项目 D:/project" });
  const session = archive.getByRole("button", {
    name: "发布准备和回滚检查",
    exact: true,
  });
  await session.press("Enter");
  await expect(archive.locator("html")).toHaveAttribute(
    "data-opened-session",
    "session-2",
  );
  const font = page.getByRole("spinbutton", { name: "界面字号" });
  for (const [theme, px] of [
    ["暖白", 12],
    ["暗夜", 20],
    ["暖白", 14],
  ] as const) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await font.fill(String(px));
    await font.press("Enter");
    await expect(archive.locator("html")).toHaveCSS(
      "--ui-font-size",
      px + "px",
    );
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(release).toHaveAttribute("aria-expanded", "false");
    await expect(session).toBeFocused();
    await expect(session).not.toHaveCSS("box-shadow", "none");
    expect(
      await archive.locator("main").evaluate((el) => el.scrollWidth),
    ).toBeLessThanOrEqual(320);
    expect((await session.boundingBox())!.width).toBeGreaterThan(160);
  }
  const restore = archive.getByRole("button", {
    name: "取消归档 发布准备和回滚检查",
  });
  await restore.press("Enter");
  await expect(session).toBeHidden();
  await expect(group).toBeFocused();
  await archive
    .getByRole("button", { name: "取消归档 测试会话" })
    .press("Enter");
  await expect(group).toBeHidden();
  await expect(
    archive.getByRole("searchbox", { name: "搜索已归档会话" }),
  ).toBeFocused();
  await expect(release).toHaveAttribute("aria-expanded", "false");
});
