/**
 * 流程图右下角的小地图：内容放不下时淡入，按真实位置和颜色画出阶段块与步骤卡，
 * 方框是当前看得到的范围；点或拖小地图，画布跳到那里。
 *
 * 直接量 DOM 画到 <canvas> 上（不走 React 状态）：展开收起的动画、推开阶段、滚动都会改位置，
 * 每次改完重画一遍就行。
 */

/** 小地图最宽 / 最高多少（CSS 像素）。 */
const MAP_W = 168;
const MAP_H = 120;

export function drawMinimap(scroller: HTMLElement | null, content: HTMLElement | null, map: HTMLCanvasElement | null): void {
  if (!scroller || !content || !map) return;
  const host = map.parentElement;
  const overflow = scroller.scrollWidth > scroller.clientWidth + 1 || scroller.scrollHeight > scroller.clientHeight + 1;
  host?.classList.toggle("show", overflow);
  if (!overflow) return;
  const cw = content.offsetWidth;
  const ch = Math.max(content.offsetHeight, scroller.scrollHeight);
  if (!cw || !ch) return;
  const scale = Math.min(MAP_W / cw, MAP_H / ch);
  const w = Math.max(1, Math.round(cw * scale));
  const h = Math.max(1, Math.round(ch * scale));
  const ratio = window.devicePixelRatio || 1;
  if (map.width !== w * ratio || map.height !== h * ratio) {
    map.width = w * ratio;
    map.height = h * ratio;
    map.style.width = `${w}px`;
    map.style.height = `${h}px`;
  }
  const ctx = map.getContext?.("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const origin = content.getBoundingClientRect();
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - origin.left) * scale, y: (r.top - origin.top) * scale, w: r.width * scale, h: r.height * scale };
  };
  // 阶段块和步骤卡都按它们此刻的底色与边框色画，状态颜色自然带过来。
  for (const el of content.querySelectorAll<HTMLElement>(".wf-stage, .wf-col > .wf-step")) {
    const r = box(el);
    const style = getComputedStyle(el);
    ctx.fillStyle = style.backgroundColor;
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect?.(r.x, r.y, Math.max(r.w, 1), Math.max(r.h, 1), el.classList.contains("wf-stage") ? 2.5 : 1.5);
    ctx.fill();
    ctx.stroke();
  }
  // 当前看得到的范围：中性色、淡淡一层，只标出位置，不抢卡片的状态色。
  const appearance = getComputedStyle(host ?? scroller);
  const ink = appearance.getPropertyValue("--color-ink-mute").trim() || appearance.color;
  const vx = scroller.scrollLeft * scale;
  const vy = scroller.scrollTop * scale;
  const vw = Math.min(w, scroller.clientWidth * scale);
  const vh = Math.min(h, scroller.clientHeight * scale);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(vx, vy, vw, vh);
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(vx + 0.5, vy + 0.5, Math.max(0, vw - 1), Math.max(0, vh - 1));
  ctx.globalAlpha = 1;
}

/** 小地图上一点 → 让画布以那一点为中心。 */
export function jumpTo(scroller: HTMLElement, content: HTMLElement, map: HTMLCanvasElement, clientX: number, clientY: number): void {
  const r = map.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = (clientX - r.left) / r.width * content.offsetWidth;
  const y = (clientY - r.top) / r.height * Math.max(content.offsetHeight, scroller.scrollHeight);
  scroller.scrollTo?.({ left: x - scroller.clientWidth / 2, top: y - scroller.clientHeight / 2 });
}
