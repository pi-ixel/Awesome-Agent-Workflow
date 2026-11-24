import { expect, test } from "@playwright/test";

const fixture = "/tests/visual/fixture.html?hint-motion";

test("rich cards unfold from the anchor edge and disable interaction as they fade out", async ({ page }) => {
  await page.goto(fixture);
  const open = page.getByRole("button", { name: "打开统计" });
  const close = page.getByRole("button", { name: "关闭统计" });
  const card = page.getByTestId("hint-motion-card");
  const halfway = await open.evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const card = document.querySelector<HTMLElement>('[data-testid="hint-motion-card"]')!;
    const style = getComputedStyle(card);
    const [, originY] = style.transformOrigin.split(" ").map(Number.parseFloat);
    const transitions = card.getAnimations().filter((animation) => animation instanceof CSSTransition);
    const fade = transitions.find((animation) => animation.transitionProperty === "opacity")!;
    const unfold = transitions.find((animation) => animation.transitionProperty === "scale")!;
    fade.pause();
    unfold.pause();
    unfold.currentTime = 0;
    const startScale = Number(style.scale);
    fade.currentTime = 60;
    unfold.currentTime = 60;
    const result = {
      startScale,
      scale: Number(style.scale),
      opacity: Number(style.opacity),
      originY,
      height: card.offsetHeight,
    };
    fade.play();
    unfold.play();
    return result;
  });
  expect(halfway.opacity).toBeGreaterThan(0);
  expect(halfway.opacity).toBeLessThan(1);
  expect(halfway.startScale).toBeCloseTo(0.98, 3);
  expect(halfway.scale).toBeGreaterThan(halfway.startScale);
  expect(halfway.scale).toBeLessThan(1);
  expect(halfway.originY).toBeCloseTo(halfway.height, 0);
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card).toHaveCSS("scale", "1");
  await expect(card).toHaveCSS("border-radius", "12px");

  const exit = await close.evaluate(async (button) => {
    const selector = '[data-testid="hint-motion-card"]';
    const card = document.querySelector<HTMLElement>(selector)!;
    (button as HTMLButtonElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const opacity = () => Number(getComputedStyle(card).opacity);
    opacity();
    const fade = card.getAnimations().find((animation) =>
      animation instanceof CSSTransition && animation.transitionProperty === "opacity",
    )!;
    fade.pause();
    fade.currentTime = 60;
    const result = {
      opacity: opacity(),
      scale: getComputedStyle(card).scale,
      inert: card.inert,
      pointerEvents: getComputedStyle(card).pointerEvents,
    };
    fade.play();
    const open = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "打开统计")!;
    open.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { ...result, reused: card === document.querySelector(selector) };
  });
  expect(exit.opacity).toBeGreaterThan(0);
  expect(exit.opacity).toBeLessThan(1);
  expect(exit.scale).toBe("1");
  expect(exit.inert).toBe(true);
  expect(exit.pointerEvents).toBe("none");
  expect(exit.reused).toBe(true);
  await expect(card).toHaveCSS("opacity", "1");
  await close.click();
  await expect(page.getByRole("dialog", { name: "统计示例" })).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

test("changed trailing digits move a fraction of a line and refocus on the latest value", async ({ page }) => {
  await page.goto(fixture);
  const open = page.getByRole("button", { name: "打开统计" });
  const metric = page.getByTestId("hint-motion-value");
  const motion = await open.evaluate(async (button) => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const click = (text: string) =>
      Array.from(document.querySelectorAll("button")).find((button) => button.textContent === text)!.click();
    (button as HTMLButtonElement).click();
    await nextFrame();
    const metric = document.querySelector('[data-testid="hint-motion-value"]')!;
    const bornStill = metric.getAnimations({ subtree: true }).length === 0;
    const glyph = Array.from(metric.querySelectorAll("[data-hint-digit]")).at(-1)!;
    const sample = () => {
      const style = getComputedStyle(glyph);
      return {
        offset: style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42,
        blur: Number.parseFloat(style.filter.split("(")[1] ?? "0"),
      };
    };
    click("第一次刷新");
    await nextFrame();
    const [first] = glyph.getAnimations();
    const animatedDigits = metric.getAnimations({ subtree: true }).length;
    const duration = first!.effect?.getTiming().duration;
    first!.pause();
    first!.currentTime = 0;
    const initial = sample();
    first!.currentTime = 140;
    const middle = sample();
    click("第二次刷新");
    await nextFrame();
    const [second] = glyph.getAnimations();
    second!.pause();
    second!.currentTime = 0;
    const retargeted = sample();
    second!.play();
    return {
      bornStill,
      animatedDigits,
      duration,
      initial,
      middle,
      retargeted,
      reused: glyph === Array.from(metric.querySelectorAll("[data-hint-digit]")).at(-1),
    };
  });
  expect(motion.bornStill).toBe(true);
  expect(motion.animatedDigits).toBe(1);
  expect(motion.duration).toBe(380);
  expect(motion.initial.offset).toBeCloseTo(1.5);
  expect(motion.initial.blur).toBeCloseTo(0.9);
  expect(motion.middle.offset).toBeGreaterThan(0);
  expect(motion.middle.offset).toBeLessThan(motion.initial.offset);
  expect(motion.middle.blur).toBeLessThan(motion.initial.blur);
  expect(motion.retargeted.offset).toBeCloseTo(motion.middle.offset, 2);
  expect(motion.retargeted.blur).toBeCloseTo(motion.middle.blur, 2);
  expect(motion.reused).toBe(true);
  await expect(metric).toHaveText("16.2 tok/s");
  const glyph = metric.locator("[data-hint-digit]").last();
  await expect(glyph).toHaveCSS("filter", "none");
  await expect(glyph).toHaveCSS("transform", "none");

  const reopensStill = await open.evaluate(async (button) => {
    const close = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent === "关闭统计")!;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    close.click();
    await nextFrame();
    (button as HTMLButtonElement).click();
    await nextFrame();
    const card = document.querySelector('[data-testid="hint-motion-value"]')!;
    return card.getAnimations({ subtree: true }).length === 0;
  });
  expect(reopensStill).toBe(true);
  await expect(metric).toHaveText("16.2 tok/s");
  await page.getByRole("button", { name: "大幅跳变" }).click();
  await expect(metric).toHaveText("94.7 tok/s");
  expect(await metric.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.getByRole("button", { name: "未知值" }).click();
  await expect(metric).toHaveText("未知");
  await expect(metric.locator("[data-hint-digit]")).toHaveCount(0);
});

test("numbers use the UI font with a stable baseline and a shared right edge in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(fixture);
  await page.getByRole("button", { name: "打开统计" }).click();
  const layout = await page.getByTestId("hint-motion-card").evaluate((card) => {
    const reference = card.querySelector('[data-testid="hint-baseline-reference"]')!;
    const value = card.querySelector('[data-testid="hint-motion-value"] .hint-number-text')!;
    const peer = card.querySelector('[data-testid="hint-alignment-peer"] .hint-number')!;
    const overlay = card.querySelector('[data-testid="hint-motion-value"] .hint-number-overlay')!;
    const topOfText = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().top;
    };
    return {
      baselineGap: topOfText(value) - topOfText(reference),
      overlayGap: overlay.getBoundingClientRect().top - value.getBoundingClientRect().top,
      edgeGap: value.getBoundingClientRect().right - peer.getBoundingClientRect().right,
      commonFont: getComputedStyle(reference).fontFamily === getComputedStyle(value).fontFamily,
      right: card.getBoundingClientRect().right,
    };
  });
  expect(Math.abs(layout.baselineGap)).toBeLessThan(1);
  expect(Math.abs(layout.overlayGap)).toBeLessThan(1);
  expect(Math.abs(layout.edgeGap)).toBeLessThan(1);
  expect(layout.commonFont).toBe(true);
  expect(layout.right).toBeLessThanOrEqual(320);
});

test("plain text hints fade through the same surface and keep digits static", async ({ page }) => {
  await page.goto(fixture);
  const trigger = page.getByRole("button", { name: "文字提示" });
  const transitions = await trigger.evaluate(async (button) => {
    (button as HTMLButtonElement).focus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const tip = document.querySelector<HTMLElement>('.hint-surface[role="tooltip"]')!;
    tip.getBoundingClientRect();
    return tip.getAnimations()
      .filter((animation) => animation instanceof CSSTransition)
      .map((animation) => animation.transitionProperty);
  });
  expect(transitions).toEqual(["opacity"]);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveCSS("border-radius", "8px");
  await expect(tooltip).toHaveText("配额 500 tok");
  await expect(tooltip.locator("[data-hint-digit]")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-describedby");
  await page.keyboard.press("Escape");
  await expect(trigger).not.toHaveAttribute("aria-describedby");
  await expect(page.locator('.hint-surface[role="tooltip"]')).toHaveCount(0);
});

test("prefers-reduced-motion shows the final number without fading or shifting digits", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(fixture);
  await page.getByRole("button", { name: "打开统计" }).click();
  const card = page.getByTestId("hint-motion-card");
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card).toHaveCSS("scale", "none");
  await expect(card.locator(".hint-number-overlay").last()).toBeHidden();
  await expect(page.getByTestId("hint-motion-value")).toHaveText("16.4 tok/s");
  await page.getByRole("button", { name: "第一次刷新" }).click();
  await expect(page.getByTestId("hint-motion-value")).toHaveText("16.9 tok/s");
  expect(await card.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.getByRole("button", { name: "关闭统计" }).click();
  await expect(card).toHaveCount(0);
});
