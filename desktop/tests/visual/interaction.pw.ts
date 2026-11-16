import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const width of [900, 390]) {
    test(`interaction preview matches desktop ${theme} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/tests/visual/interaction.html?theme=${theme}`);
      const picker = page.getByRole("group", { name: "交互行为" });
      await expect(picker).toBeVisible();
      await expect(picker.locator("[data-interaction-composer]")).toHaveCount(
        2,
      );
      await expect(picker.getByText("正在运行的命令可能被终止。")).toHaveCount(
        0,
      );
      await picker.getByRole("button", { name: "引导", exact: true }).click();
      await expect(
        picker.getByRole("button", { name: "引导", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `node_modules/.cache/interaction-${theme}-${width}.png`,
        fullPage: true,
      });
    });
  }
}

test("keeps both preview shells and composers mounted through a full loop", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tests/visual/interaction.html");
  const picker = page.getByRole("group", { name: "交互行为" });
  await expect(picker.locator("[data-settings-preview]")).toHaveCount(2);
  const result = await picker.evaluate((root) => {
    const shells = [...root.querySelectorAll("[data-settings-preview]")];
    const composers = [...root.querySelectorAll("[data-interaction-composer]")];
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].join(",");
    };
    const boxes = composers.map(bounds);
    const animations = root
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName.startsWith("interaction-preview-"),
      );
    for (const animation of animations) animation.pause();
    const stable = [0, 1399, 2550, 4180, 6920, 7000].every((time) => {
      for (const animation of animations) animation.currentTime = time;
      return (
        shells.every(
          (shell) =>
            shell.isConnected && getComputedStyle(shell).opacity === "1",
        ) &&
        composers.every(
          (composer, index) =>
            composer.isConnected &&
            getComputedStyle(composer).opacity === "1" &&
            bounds(composer) === boxes[index],
        )
      );
    });
    return { stable, animationCount: animations.length };
  });
  expect(result.animationCount).toBeGreaterThan(0);
  expect(result.stable).toBe(true);
});
