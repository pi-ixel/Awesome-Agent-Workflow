/**
 * 流程图的变形动画：胶囊本身变成步骤卡，步骤卡缩回胶囊。
 *
 * 不另飞一个色块：步骤卡就待在它最终的位置上，动画开始时被裁成胶囊的大小、
 * 挪到胶囊的位置、涂成胶囊的颜色，然后裁剪框放开、位置归位、颜色过渡成卡片底色，
 * 内容最后浮现。收起时反过来。全部用 Web Animations，做完不留样式。
 */

export const EASE = "cubic-bezier(.22,.8,.24,1)";
export const DURATION = 460;
/** 相邻两个胶囊的错开间隔：从左到右依次走。 */
export const STAGGER = 40;
/** 推开后面的阶段、挪屏幕的时长。 */
export const ROOM_MS = 340;

/** 不做动画：用户要求减少动态，或环境没有 Web Animations（测试）。 */
export function motionOff(): boolean {
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const wait = (ms: number): Promise<void> => motionOff() ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

function pillShape(card: Element, pill: Box): Keyframe {
  const r = card.getBoundingClientRect();
  return {
    transform: `translate(${pill.left - r.left}px, ${pill.top - r.top}px)`,
    clipPath: `inset(0px ${r.width - pill.width}px ${r.height - pill.height}px 0px round ${pill.height / 2}px)`,
  };
}
const cardShape: Keyframe = { transform: "translate(0px, 0px)", clipPath: "inset(0px 0px 0px 0px round 10px)" };

/** 胶囊 → 卡片。 */
export function grow(card: HTMLElement, pill: Box, color: string, index: number): Promise<unknown> {
  const style = getComputedStyle(card);
  const face = { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor };
  const kids = [...card.children] as HTMLElement[];
  const delay = index * STAGGER;
  const shape = card.animate(
    [{ ...pillShape(card, pill), backgroundColor: color, borderColor: color }, { ...cardShape, ...face }],
    { duration: DURATION, delay, easing: EASE, fill: "backwards" },
  );
  const fades = kids.map((kid) => kid.animate(
    [{ opacity: 0, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }],
    { duration: 200, delay: delay + DURATION * 0.62, easing: "ease-out", fill: "backwards" },
  ));
  return Promise.all([shape.finished, ...fades.map((fade) => fade.finished)]).catch(() => undefined);
}

/** 卡片 → 胶囊（卡片是浮层上的复制品，做完由调用方移除）。sp 是倍速。 */
export function shrink(card: HTMLElement, pill: Box, color: string, index: number, sp = 1): Promise<unknown> {
  const style = getComputedStyle(card);
  const face = { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor };
  const delay = index * STAGGER / sp;
  for (const kid of [...card.children]) kid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 / sp, delay, fill: "forwards" });
  return card.animate(
    [{ ...cardShape, ...face }, { ...pillShape(card, pill), backgroundColor: color, borderColor: color }],
    { duration: DURATION * 0.85 / sp, delay: delay + 60 / sp, easing: EASE, fill: "forwards" },
  ).finished.catch(() => undefined);
}
