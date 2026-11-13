/** 画布卡片的键盘焦点移动（卡片带 data-nav-x / data-nav-y 布局坐标）。 */
const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * 方向键在画布卡片之间移动焦点。先找该方向上最近的一行（列），再取横向（纵向）
 * 最近的一张；左右只在同一行里移动。焦点不在卡片上时落到当前节点或第一张卡。
 * 处理了按键时返回 true。
 */
export function moveCardFocus(container: HTMLElement, key: string, active: Element | null): boolean {
  if (!ARROWS.has(key)) return false;
  const cards = [...container.querySelectorAll<HTMLElement>("[data-nav-x]")];
  if (cards.length === 0) return false;
  const point = (card: HTMLElement) => ({ x: Number(card.dataset.navX), y: Number(card.dataset.navY) });
  const from = cards.find((card) => card === active);
  if (!from) {
    (cards.find((card) => card.closest("[data-current='true']")) ?? cards[0])!.focus();
    return true;
  }
  const a = point(from);
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const sign = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
  const candidates = cards.filter((card) => card !== from).map((card) => {
    const b = point(card);
    return { card, along: ((vertical ? b.y - a.y : b.x - a.x) * sign), across: Math.abs(vertical ? b.x - a.x : b.y - a.y) };
  }).filter((c) => c.along > 1 && (vertical || c.across < 20));
  if (candidates.length === 0) return true;
  const nearest = Math.min(...candidates.map((c) => c.along));
  const best = candidates.filter((c) => c.along <= nearest + 10).sort((x, y) => x.across - y.across)[0]!;
  best.card.focus();
  return true;
}
