import { expect, test } from "@playwright/test";

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const rgb = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const channel = v / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

for (const theme of ["warm", "dark"]) {
  for (const percent of [0, 11.1, 92.7, 100]) {
    test(`${theme} 上下文 ${percent}% 的条内百分比保持对齐和对比度`, async ({
      page,
    }) => {
      await page.goto(
        `/tests/visual/sessionStatusOverlayFixture.html?context-percent=${percent}`,
      );
      await page.evaluate(
        (mode) =>
          document.documentElement.classList.toggle(
            "theme-warm",
            mode === "warm",
          ),
        theme,
      );
      await page
        .getByRole("button", { name: "上下文用量", exact: true })
        .hover();
      const card = page.getByRole("dialog", { name: "上下文容量" });
      await expect(card).toHaveCSS("scale", "1");
      const bar = card.getByRole("progressbar", { name: "上下文占用" });
      await expect(bar).toHaveCSS("height", "16px");
      await expect(bar).toHaveAttribute("aria-valuetext", `${percent}%`);
      await expect(card).not.toContainText(`（${percent}%）`);
      const sample = await bar.evaluate((element) => {
        const [fill, label] = Array.from(element.children) as HTMLElement[];
        const box = element.getBoundingClientRect();
        const labelBox = label!.getBoundingClientRect();
        return {
          barWidth: box.width,
          fillWidth: fill!.getBoundingClientRect().width,
          rightInset: box.right - labelBox.right,
          labelFits: labelBox.top >= box.top && labelBox.bottom <= box.bottom,
          signSize: getComputedStyle(label!.lastElementChild!).fontSize,
          numberSize: getComputedStyle(label!).fontSize,
          weight: getComputedStyle(label!).fontWeight,
          track: getComputedStyle(element).backgroundColor,
          ink: getComputedStyle(label!).color,
          fill: getComputedStyle(fill!).backgroundColor,
        };
      });
      expect(sample.barWidth).toBeGreaterThan(285);
      expect(sample.barWidth).toBeLessThan(300);
      expect(sample.fillWidth / sample.barWidth).toBeCloseTo(percent / 100, 2);
      expect(sample.rightInset).toBeCloseTo(8);
      expect(sample.labelFits).toBe(true);
      expect(sample.signSize).toBe("11px");
      expect(sample.numberSize).toBe("12px");
      expect(sample.weight).toBe("400");
      expect(contrast(sample.ink, sample.track)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(sample.ink, sample.fill)).toBeGreaterThanOrEqual(4.5);
    });
  }
}
