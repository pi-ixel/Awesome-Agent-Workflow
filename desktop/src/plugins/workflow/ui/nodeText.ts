/** 节点在卡片和检视器上的文字：类型标签与时间（ADR 035）。 */
import type { CanvasNodeSnapshot } from "../types.ts";
import type { BadgeTone } from "../../../shared/ui/controls.tsx";
import type { NodeState } from "../status/snapshot.ts";
import { nodeTiming } from "../status/timing.ts";
import { durationPhrase } from "./time.ts";

/** 节点类型的中文标签；不认识的类型统一叫「节点」，不显示内部类型名。 */
const KIND_BADGE: Record<string, string> = { agent: "Agent", python: "脚本", flow: "子流程" };
export const kindBadge = (kind: string): string => KIND_BADGE[kind] ?? "节点";

/** 卡片上的时间：在等你时说等了多久，执行中说已运行多久，结束后（或运行已停下）说用时。没有当前时刻时不显示。 */
export function cardTime(record: CanvasNodeSnapshot | undefined, now: number | undefined, stopped = false): string {
  const timing = record && now !== undefined ? nodeTiming(record, now) : null;
  if (!timing) return "";
  if (timing.waitingMs !== null) return durationPhrase("等你", timing.waitingMs);
  return durationPhrase(timing.finished || stopped ? "用时" : "已运行", timing.elapsedMs);
}

/** 项目里的相对路径原样显示；绝对路径只显示文件名，完整路径放在悬停提示里。 */
export function shortPath(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path) ? path.split(/[\\/]/).pop() || path : path;
}

/** 节点状态 → 徽标语气（状态文字统一用公共 Badge）。 */
export const STATE_TONE: Readonly<Record<NodeState, BadgeTone>> = {
  pending: "neutral",
  running: "info",
  done: "ok",
  "done-findings": "ok",
  stuck: "warn",
  blocked: "warn",
  failed: "danger",
  skipped: "neutral",
};

/** 运行状态（引擎 run.status）→ 徽标语气。 */
export function runTone(status: string, blocked = false): BadgeTone {
  if (blocked) return "warn";
  return ({ running: "info", waiting: "warn", completed: "ok", failed: "danger" } as Record<string, BadgeTone>)[status] ?? "neutral";
}
