/** 节点与运行的用时（ADR 035）。时间来自引擎记录，界面只做加减。 */
import type { CanvasNodeSnapshot } from "../types.ts";

export interface NodeTiming {
  readonly startedAt: number;
  /** 从开始到结束（仍在执行时到现在）的总时长。 */
  readonly elapsedMs: number;
  /** 其中等你回复的时长，含正在进行的这次等待。 */
  readonly waitedMs: number;
  /** 正在进行的这次等待已持续多久；没在等时为 null。 */
  readonly waitingMs: number | null;
  readonly finished: boolean;
}

type TimedRecord = Pick<CanvasNodeSnapshot, "startedAt" | "endedAt" | "waitedMs" | "awaitingInputSince" | "status">;

/** 没有开始时间（旧记录或被跳过）时返回 null。 */
export function nodeTiming(record: TimedRecord, now: number): NodeTiming | null {
  if (record.startedAt === undefined) return null;
  const finished = record.endedAt !== undefined;
  const end = record.endedAt ?? Math.max(now, record.startedAt);
  const waitingMs = !finished && record.awaitingInputSince !== undefined
    ? Math.max(0, now - record.awaitingInputSince)
    : null;
  return {
    startedAt: record.startedAt,
    elapsedMs: Math.max(0, end - record.startedAt),
    waitedMs: (record.waitedMs ?? 0) + (waitingMs ?? 0),
    waitingMs,
    finished,
  };
}

/** 整次运行里等你回复的总时长；作废的记录不算。 */
export function runWaitedMs(records: readonly (TimedRecord & Pick<CanvasNodeSnapshot, "mark">)[], now: number): number {
  return records.reduce((sum, record) => record.mark === "superseded" ? sum : sum + (nodeTiming(record, now)?.waitedMs ?? 0), 0);
}

/**
 * 整次运行真正在跑的时长：所有节点执行时段的并集（作废的也算，它们确实跑过）。
 * 运行停着、没有节点在跑的那段时间不计——停一天再继续，不会显示「用时 1 天」。
 * 正在跑的节点算到 `now`；被打断的节点不知道真实停在哪一刻，不计入
 * （否则会一直算到它被作废或运行最后结束）。
 */
export function runActiveMs(records: readonly Pick<CanvasNodeSnapshot, "startedAt" | "endedAt" | "status">[], now: number, active: boolean): number {
  // 正常结束的节点按记录的起止算；被打断的（停下时还在跑、之后被回退作废）结束时刻
  // 是作废那一刻，不是真实工作时长，不计。
  const counted = (record: Pick<CanvasNodeSnapshot, "endedAt" | "status">) =>
    record.status === "running" ? active && record.endedAt === undefined : record.status === "completed" || record.status === "failed" || record.status === "skipped";
  const spans = records
    .flatMap((record) => record.startedAt === undefined || !counted(record) ? []
      : [[record.startedAt, Math.max(record.startedAt, record.endedAt ?? now)] as const])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = -Infinity;
  let end = -Infinity;
  for (const [from, to] of spans) {
    if (from > end) {
      if (end > start) total += end - start;
      start = from;
      end = to;
    } else {
      end = Math.max(end, to);
    }
  }
  if (end > start) total += end - start;
  return total;
}
