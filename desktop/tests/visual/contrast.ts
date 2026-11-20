import type { Locator } from "@playwright/test";

type Color = [number, number, number, number];
export function parse(value: string): Color {
  const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
}
export function blend(fg: Color, bg: Color): Color {
  return [0, 1, 2]
    .map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]))
    .concat(1) as Color;
}
export function ratio(a: Color, b: Color): number {
  const luminance = (c: Color) =>
    c
      .slice(0, 3)
      .map((n) => n / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light! + 0.05) / (dark! + 0.05);
}
export async function color(el: Locator, property: string) {
  return el.evaluate((node, key): Color => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建颜色解析上下文");
    context.fillStyle = getComputedStyle(node).getPropertyValue(key);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  }, property);
}
