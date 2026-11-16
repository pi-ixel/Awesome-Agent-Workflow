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
