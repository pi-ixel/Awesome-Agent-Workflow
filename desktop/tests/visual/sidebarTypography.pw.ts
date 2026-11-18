import { expect, test } from "@playwright/test";

for (const theme of ["dark", "warm"]) {
  test(`${theme} 主题的任务与会话标题在不同字号下保持一致`, async ({
    page,
  }) => {
    await page.goto("/tests/visual/sidebarTypographyFixture.html");
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle(
          "theme-warm",
          theme === "warm",
        ),
      theme,
    );
    const conversation = page
      .getByRole("region", { name: "会话标题" })
      .getByText("说你好 AAW");
    const task = page
      .getByRole("region", { name: "定时任务列表" })
      .getByText("说你好 AAW");
    const font = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    for (const size of [12, 14, 20]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--ui-font-size",
            `${size}px`,
          ),
        size,
      );
      await expect(task).toHaveCSS("font-size", `${size}px`);
      expect(await task.evaluate(font)).toEqual(
        await conversation.evaluate(font),
      );
    }
    await page.getByRole("button", { name: "说你好 AAW 每天" }).click();
    await expect(task).toBeVisible();
    expect(await task.evaluate(font)).toEqual(
      await conversation.evaluate(font),
    );
  });
}
