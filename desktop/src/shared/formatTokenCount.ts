const compactCount = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 容量和额度使用千位缩写，如 55.5k、500k、1.2M。 */
export function formatTokenCount(value: number): string {
  return compactCount.format(value).replace(/K$/, "k");
}
