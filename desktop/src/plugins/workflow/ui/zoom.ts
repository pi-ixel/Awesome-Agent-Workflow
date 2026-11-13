/** 画布缩放：范围、取整，以及「适应窗口」要用的缩放值。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.3;

export const clampZoom = (value: number): number => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 10) / 10;

/** 缩放到整张图放得下（不放大、不低于最小缩放）；量不出尺寸时返回 null。 */
export function fitZoom(viewport: HTMLElement | null, zoom: number): number | null {
  const stage = viewport?.querySelector<HTMLElement>(".workflow-stage");
  if (!viewport || !stage) return null;
  const height = stage.scrollHeight / zoom;
  const width = stage.scrollWidth / zoom;
  if (!height || !width) return null;
  return clampZoom(Math.floor(Math.min(viewport.clientHeight / height, viewport.clientWidth / width, 1) * 10) / 10);
}
