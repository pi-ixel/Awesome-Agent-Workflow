/**
 * 消息流窗口化的纯逻辑：长会话（几百上千条目）不整棵渲染——只渲染
 * 最近 `WINDOW_CHUNK` 条，滚动到顶时按块向前补载（loadOlder）。锚定
 * 补载（前插内容不把视口顶飞）与跟随状态机在 SessionView 组件里，
 * 这里只放可单测的判定。
 */
/** 初始/补载窗口大小（条）。 */
export const WINDOW_CHUNK = 150;

/** 距顶阈值（px）：滚动位置在此内且有未揭示历史时补载一块。 */
export const LOAD_OLDER_THRESHOLD_PX = 240;

/** 距底阈值（px）：在此范围内视为「贴底跟随」。 */
export const NEAR_BOTTOM_PX = 48;

/** 窗口切片：只保留最近 visibleCount 条（不足则全量）。 */
export function sliceVisible<T>(
  items: readonly T[],
  visibleCount: number,
): readonly T[] {
  if (items.length <= visibleCount) {
    return items;
  }
  return items.slice(items.length - visibleCount);
}

/** 是否应补载更早的条目：贴顶且确有未揭示历史。 */
export function shouldLoadOlder(
  scrollTop: number,
  hiddenCount: number,
): boolean {
  return hiddenCount > 0 && scrollTop <= LOAD_OLDER_THRESHOLD_PX;
}

/** 是否贴底（跟随态的判据）。 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX;
}
