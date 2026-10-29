/**
 * 轮内已完成工作的折叠投影（纯函数）：把窗口化切片里的条目流重组为
 * 渲染单元——「轮」以用户消息分界；轮内**连续**的已完成思考块 / 已完成
 * 读取/搜索或执行工具卡（≥2 张才成组）折叠为工作组，类别变化时分组。
 * 编辑及其他无法确定类别的工具保持独立可见。
 * 组外保留：assistant 文本、流式/运行中条目、失败的工具卡（排障现场）、
 * 系统提示与用户消息。
 *
 * 折叠组的耗时合并重叠时间段；缺少时间时不展示不完整的耗时。
 * 作用在 sessionWindow 切片之后，
 * 不碰补载锚定与跟随状态机。
 */
import type { SessionItem } from "../../stores/sessionStore.ts";

export type TurnUnit =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly item: SessionItem;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly items: readonly SessionItem[];
      /** 组内可计条目的耗时合计；无可计条目为 null。 */
      readonly elapsedMs: number | null;
    };

type WorkCategory = "thought" | "explore" | "execute";

/** 只对协议明确分类的工具分组，不推测未知工具的效果。 */
function workCategory(item: SessionItem): WorkCategory | null {
  if (item.kind === "thought") {
    return item.isStreaming ? null : "thought";
  }
  if (item.kind !== "tool" || item.status !== "completed") return null;
  if (item.toolKind === "read" || item.toolKind === "search") return "explore";
  if (item.toolKind === "execute") return "execute";
  return null;
}

/** 计算有记录的工作时间，重叠执行只计一次。 */
function workElapsedMs(items: readonly SessionItem[]): number | null {
  const intervals: [number, number][] = [];
  for (const item of items) {
    if (item.kind !== "thought" && item.kind !== "tool") return null;
    const { startedAt, endedAt } = item;
    if (
      startedAt === null ||
      endedAt === null ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      endedAt < startedAt
    )
      return null;
    intervals.push([startedAt, endedAt]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = intervals[0]!;
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + end - start;
}

/** 连续可折叠段 ≥2 才成组（单张折叠是负优化：多一次点击零降噪）。 */
const MIN_GROUP_SIZE = 2;

export function groupTurnWork(
  items: readonly SessionItem[],
): readonly TurnUnit[] {
  const units: TurnUnit[] = [];
  let run: SessionItem[] = [];
  let category: Exclude<WorkCategory, "thought"> | null = null;
  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= MIN_GROUP_SIZE) {
      units.push({
        kind: "work",
        id: `work-${run[0]!.id}`,
        items: run,
        elapsedMs: workElapsedMs(run),
      });
    } else {
      for (const item of run) {
        units.push({ kind: "item", id: item.id, item });
      }
    }
    run = [];
    category = null;
  };
  for (const item of items) {
    const next = workCategory(item);
    if (next !== null) {
      if (next !== "thought" && category !== null && category !== next)
        flushRun();
      run.push(item);
      if (next !== "thought") category = next;
    } else {
      flushRun();
      units.push({ kind: "item", id: item.id, item });
    }
  }
  flushRun();
  return units;
}
