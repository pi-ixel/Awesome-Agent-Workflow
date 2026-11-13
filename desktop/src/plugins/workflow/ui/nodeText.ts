/** 节点在卡片和检视器上的文字：类型标签与时间（ADR 035）。 */
import type { CanvasNodeSnapshot } from "../types.ts";
import { nodeTiming } from "../status/timing.ts";
import { durationPhrase } from "./time.ts";

/** 节点类型的中文标签；不认识的类型统一叫「节点」，不显示内部类型名。 */
const KIND_BADGE: Record<string, string> = { agent: "Agent", python: "脚本", flow: "子流程" };
export const kindBadge = (kind: string): string => KIND_BADGE[kind] ?? "节点";

/** 卡片上的时间：在等你时说等了多久，执行中说已运行多久，结束后说用时。没有当前时刻时不显示。 */
export function cardTime(record: CanvasNodeSnapshot | undefined, now: number | undefined): string {
  const timing = record && now !== undefined ? nodeTiming(record, now) : null;
  if (!timing) return "";
  if (timing.waitingMs !== null) return durationPhrase("等你", timing.waitingMs);
  return durationPhrase(timing.finished ? "用时" : "已运行", timing.elapsedMs);
}
