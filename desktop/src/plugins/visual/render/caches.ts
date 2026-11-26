import { clearVisualHeights } from "./layoutCache.ts";
import { clearVisualPlans } from "./plan.ts";

/** 清空讲解图的内存缓存（插件卸载时调用）。 */
export function clearVisualCaches(): void {
  clearVisualPlans();
  clearVisualHeights();
}
