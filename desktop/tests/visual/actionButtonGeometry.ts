import { expect, type Locator } from "@playwright/test";

export const actionInkCenterTolerance = 0.875;

export async function actionButtonGeometry(button: Locator) {
  return button.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(
      ":scope > .action-button-label",
    )!;
    const icon = element.querySelector(":scope > svg");
    const box = element.getBoundingClientRect();
    const textBox = label.getBoundingClientRect();
    const iconBox = icon?.getBoundingClientRect();
    const text = label.textContent?.trim() ?? "";
    const style = getComputedStyle(label);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ink = context.measureText(text);
    const marker = document.createElement("i");
    marker.style.cssText =
      "display:inline-block;width:0;height:0;vertical-align:baseline";
    label.append(marker);
    const baseline = marker.getBoundingClientRect().top;
    marker.remove();
    const middle = box.top + box.height / 2;
    const left = Math.min(textBox.left, iconBox?.left ?? textBox.left);
    const right = Math.max(textBox.right, iconBox?.right ?? textBox.right);
    return {
      height: box.height,
      contentX: (left + right) / 2 - (box.left + box.width / 2),
      iconY: iconBox ? iconBox.top + iconBox.height / 2 - middle : 0,
      inkY:
        baseline +
        (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2 -
        middle,
    };
  });
}

export async function expectCenteredAction(button: Locator) {
  await expect(button).toBeVisible();
  const geometry = await actionButtonGeometry(button);
  expect(Math.abs(geometry.contentX)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.iconY)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.inkY)).toBeLessThanOrEqual(actionInkCenterTolerance);
  return geometry;
}
