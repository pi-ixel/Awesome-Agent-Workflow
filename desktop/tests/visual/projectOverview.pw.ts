import { expect, test } from "@playwright/test";

for (const theme of ["warm", "dark"]) {
  test(`${theme}：项目总览引导在内容区居中，缩放后保留顶部项目信息`, async ({
    page,
  }) => {
    await page.goto(
      "/tests/visual/sessionStatusOverlayFixture.html?right-panel&workbench&project-overview",
    );
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("theme-warm", theme === "warm");
    }, theme);
    const region = page.getByRole("region", { name: "项目状态" });
    const guide = region.getByRole("status");
    const action = region.getByRole("button", {
      name: "新建会话",
      exact: true,
    });
    await expect(action).toBeEnabled();
    await expect(region).toHaveCSS("border-top-width", "0px");
    await expect(
      region.getByText("在当前项目中开始与 agent 对话。"),
    ).toBeVisible();
    await expect(
      region.getByText("从左侧选择已有会话，或新建一个会话。"),
    ).toBeVisible();
    for (const [width, height, fontSize] of [
      [1280, 800, 14],
      [960, 640, 20],
      [1024, 700, 20],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((size) => {
        document.documentElement.style.setProperty(
          "--ui-font-size",
          `${size}px`,
        );
      }, fontSize);
      await expect(action).toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "status-overlay", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("D:/status-overlay", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => {
          const content = (await region
            .locator("..")
            .locator("..")
            .boundingBox())!;
          const group = (await guide.boundingBox())!;
          return Math.max(
            Math.abs(group.x + group.width / 2 - content.x - content.width / 2),
            Math.abs(
              group.y + group.height / 2 - content.y - content.height / 2,
            ),
          );
        })
        .toBeLessThanOrEqual(1);
    }
  });
}
