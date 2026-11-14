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
