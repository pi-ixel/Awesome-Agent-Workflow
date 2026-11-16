/** 画布缩放：范围、取整，以及「适应窗口」要用的缩放值。 */
// 上限跟原型一致（原型 setZoom 上限 1.6）：放大才有机会超出视口宽度，横向拖动才有余量。
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.6;

export const clampZoom = (value: number): number => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;

/**
 * 「适应」= 整张流程图放得下：宽、高都要进来（报告第一页承诺的「510×1184 ·
 * 适应 60%」正是 712 高的视口除以 1184 的高）。从前只按宽度收，纵向「本来该滚」，
 * 结果在比视口高的图上点「适应」算出来还是 100%，功能读起来就是坏的。
 * 装不下时缩到 ZOOM_MIN 为止，再往下才把余量交给滚动。
 *
 * 量的是**图形本体**的宽高，不是 `.workflow-stage`：stage 是 `width:max-content`
 * （内容比视口宽时 stage 自己就会被撑开），它会把 scrollWidth 顶到视口宽；
 * 再除以 zoom 就得到一个「算出多少就停在多少」的不动点 —— 面板从窄拉宽后，
 * 图会永远卡在之前算出的缩放。
 *
 * 取整**向下**：四舍五入会算出一个放大档（0.5858 → 0.59），图就多溢出 7px；
 * 向下取到两位小数，装不下才溢出，装得下绝不溢出。
 *
 * 不放大（最多 1）；量不出尺寸时返回 null。
 */
export function fitZoom(viewport: HTMLElement | null, zoom: number): number | null {
  const stage = viewport?.querySelector<HTMLElement>(".workflow-stage");
  if (!viewport || !stage) return null;
  const content = stage.firstElementChild instanceof HTMLElement ? stage.firstElementChild : stage;
  const width = (content.scrollWidth || stage.scrollWidth) / zoom;
  const height = (content.scrollHeight || stage.scrollHeight) / zoom;
  if (!width || !height) return null;
  const fit = Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1);
  return Math.max(ZOOM_MIN, Math.floor(fit * 100) / 100);
}
