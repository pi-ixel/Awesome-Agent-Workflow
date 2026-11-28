import { expect, test } from "@playwright/test";

for (const theme of ["暖白", "暗夜"]) {
  test(`${theme} 下删除技能保留确认，结果只在右下角 Toast 展示`, async ({
    page,
    context,
  }) => {
    await page.goto("/tests/visual/uiScaleFixture.html");
    await page.getByRole("button", { name: theme, exact: true }).click();
    const skills = await context.newPage();
    await skills.setViewportSize({ width: 1200, height: 900 });
    await skills.goto(
      "/tests/visual/sidebarTypographyFixture.html?collections",
    );
    const title = "发布准备和回滚预案的完整审查";
    const card = skills.getByRole("article", { name: title });
    await card.getByRole("button", { name: `${title} 删除` }).click();
    const confirm = skills.getByRole("dialog", { name: "确认技能操作" });
    await expect(confirm).toBeVisible();
    await expect(card).toBeVisible();
    await confirm
      .getByRole("button", { name: "永久删除", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    const host = skills.locator("[data-toast-host]");
    await expect(host).toContainText(`${title} · 已永久删除`);
    await expect(host).toHaveCSS("position", "fixed");
    await expect(host).toHaveCSS("right", "20px");
    await expect(host).toHaveCSS("bottom", "20px");
    await expect(
      skills.getByText(`${title} · 已永久删除`, { exact: true }),
    ).toHaveCount(1);
    await expect(
      skills.getByRole("article", { name: "旧版发布检查" }),
    ).toBeVisible();
  });
}
