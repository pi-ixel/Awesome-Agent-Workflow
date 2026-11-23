/** 鼠标一格固定缩放约 2%，触控板的小增量保留连续手感。 */
export function previewWheelZoomFactor(deltaY: number): number {
  const step =
    Math.abs(deltaY) >= 50
      ? -Math.sign(deltaY) * Math.log(1.02)
      : -deltaY * 0.01;
  return Math.exp(step);
}
