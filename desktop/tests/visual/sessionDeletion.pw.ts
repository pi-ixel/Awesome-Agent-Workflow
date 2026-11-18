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
