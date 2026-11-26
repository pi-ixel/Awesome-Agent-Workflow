/**
 * 讲解图高度缓存（按源码哈希）：沙箱 iframe 卸载后用记住的高度占位，
 * 翻历史、虚拟化重挂、切回会话时版面不跳。只存本次运行的内存。
 */
const heights = new Map<string, number>();
const LIMIT = 300;

export function rememberVisualHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  heights.delete(key);
  heights.set(key, Math.ceil(height));
  while (heights.size > LIMIT) {
    const oldest = heights.keys().next();
    if (oldest.done === true) break;
    heights.delete(oldest.value);
  }
}

export function recallVisualHeight(key: string): number | undefined {
  return heights.get(key);
}

export function clearVisualHeights(): void {
  heights.clear();
}
