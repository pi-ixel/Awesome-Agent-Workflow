/**
 * 小地图的数据：从画布 DOM 读出各卡片的位置与状态。显示规则见 Minimap.tsx。
 */
export type OverviewTone = "idle" | "done" | "active" | "warn" | "danger";
/** 位置都是画布内容坐标（像素，已含缩放）。 */
export interface OverviewMark { readonly top: number; readonly left: number; readonly width: number; readonly height: number; readonly tone: OverviewTone }
export interface Overview {
  /** 画布内容的总高、总宽。 */
  readonly total: number;
  readonly width: number;
  readonly viewTop: number;
  readonly viewLeft: number;
  readonly viewHeight: number;
  readonly viewWidth: number;
  /** 视口右侧滚动条占的宽度：小地图放在它左边。 */
  readonly gutter: number;
  readonly marks: readonly OverviewMark[];
}

/** 画布明显长出视口（超过一成）就显示小地图；只差几像素时不显示。 */
const SHOW_RATIO = 1.1;

function toneOf(card: HTMLElement): OverviewTone | null {
  if (card.classList.contains("workflow-band-summary")) return "done";
  const host = card.closest<HTMLElement>(".workflow-phase.call") ?? card;
  const status = host.querySelector(".workflow-status");
  // 流程预览的卡片不写状态：淡色标出位置。
  if (!status) return "idle";
  const has = (name: string) => status.classList.contains(name);
  if (has("state-failed")) return "danger";
  if (has("waiting") || has("state-stuck") || has("state-blocked") || host.querySelector(".attention")) return "warn";
  if (has("state-running")) return "active";
  if (has("state-done") || has("state-done-findings")) return "done";
  // 未运行（或流程预览）：淡色标出位置，小地图仍能看出整张图的结构。
  return "idle";
}

/** 从画布 DOM 读出各卡片的位置与状态（已含缩放与画布上方的面包屑等偏移）。 */
export function readOverview(viewport: HTMLElement): Overview | null {
  const total = viewport.scrollHeight;
  const viewHeight = viewport.clientHeight;
  if (!total || !viewHeight || total < viewHeight * SHOW_RATIO) return null;
  const box = viewport.getBoundingClientRect();
  const originTop = box.top - viewport.scrollTop;
  const originLeft = box.left - viewport.scrollLeft;
  const marks = [...viewport.querySelectorAll<HTMLElement>("[data-nav-x]")].flatMap((card) => {
    const tone = toneOf(card);
    if (!tone) return [];
    // 子流程卡的焦点落在「进入」按钮上，位置取整张卡。
    const rect = (card.closest<HTMLElement>(".workflow-phase.call") ?? card).getBoundingClientRect();
    return [{ top: rect.top - originTop, left: rect.left - originLeft, width: rect.width, height: rect.height, tone }];
  });
  return {
    total,
    width: viewport.scrollWidth,
    viewTop: viewport.scrollTop,
    viewLeft: viewport.scrollLeft,
    viewHeight,
    viewWidth: viewport.clientWidth,
    gutter: Math.max(0, viewport.offsetWidth - viewport.clientWidth),
    marks,
  };
}

export function sameOverview(a: Overview | null, b: Overview | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
