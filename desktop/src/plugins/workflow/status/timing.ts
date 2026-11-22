/** 节点与运行的用时（ADR 035）。时间来自引擎记录，界面只做加减。 */
import type { CanvasNodeSnapshot, CanvasSnapshot } from "../types.ts";

/**
 * 计时用的时钟：当前时刻，加上运行的执行时段（引擎记录）。运行停着的时间不计入
 * 等待与用时——停着时截止到停下那一刻，继续后的等待从继续那一刻算起（之前那段
 * 已由引擎计入 waitedMs）。只给数字时按一直在执行算。
 */
export interface RunClock {
  readonly now: number;
  /** 运行此刻在执行。 */
  readonly active: boolean;
  /** 这一段执行从何时开始。 */
  readonly activeSince: number | null;
  /** 停着时，停下的时刻。 */
  readonly stoppedAt: number | null;
  /** 全部执行时段（起，止；正在执行的没有止）。为空时（旧运行）按一直在执行算。 */
  readonly spans: readonly (readonly [number, number | null])[];
}

export function runClock(snapshot: Pick<CanvasSnapshot, "active" | "run"> | null | undefined, now: number): RunClock {
  const run = snapshot?.run;
  const active = snapshot?.active ?? true;
  const spans = run?.spans ?? [];
  const open = spans.find(([, end]) => end === null)?.[0];
  return {
    now,
    active,
    // 刚继续运行、新的执行时段还没推到：按此刻刚开始算，不把停着的时间闪出来。
    activeSince: active ? run?.activeSince ?? open ?? (spans.length > 0 ? now : null) : null,
    // 旧引擎没有执行时段：退回最近一次更新。
    stoppedAt: active ? null : run?.stoppedAt ?? run?.updatedAt ?? null,
    spans,
  };
}

const clockOf = (clock: number | RunClock): RunClock =>
  typeof clock === "number" ? { now: clock, active: true, activeSince: null, stoppedAt: null, spans: [] } : clock;

/** [from, to] 落在执行时段里的时长；没有时段记录时就是 to - from。 */
function activeWithin(from: number, to: number, clock: RunClock): number {
  if (clock.spans.length === 0) return Math.max(0, to - from);
  return clock.spans.reduce((sum, [start, end]) =>
    sum + Math.max(0, Math.min(to, end ?? (clock.active ? clock.now : clock.stoppedAt ?? clock.now)) - Math.max(from, start)), 0);
}

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

type TimedRecord = Pick<CanvasNodeSnapshot, "startedAt" | "endedAt" | "waitedMs" | "turn" | "turnEndedAt" | "status">;

/** 没有开始时间（旧记录或被跳过）时返回 null。 */
export function nodeTiming(record: TimedRecord, clock: number | RunClock): NodeTiming | null {
  if (record.startedAt === undefined) return null;
  const c = clockOf(clock);
  const { now, active, activeSince, stoppedAt } = c;
  const finished = record.endedAt !== undefined;
  // 运行停着：没结束的节点停在停下那一刻。
  const until = active || stoppedAt === null ? now : Math.min(now, stoppedAt);
  const end = record.endedAt ?? Math.max(until, record.startedAt);
  // 最近一轮已经结束、会话空着：从那一刻起都在等你（ADR 040 轮次记录）；
  // 运行停过又继续时从继续那一刻算起，停着时不再增长。
  const idleSince = record.turn !== undefined && record.turn !== "working" ? record.turnEndedAt : undefined;
  const waitingMs = !finished && idleSince !== undefined && active
    ? Math.max(0, now - Math.max(idleSince, activeSince ?? idleSince))
    : null;
  return {
    startedAt: record.startedAt,
    // 只算运行在执行的时段（停着的那段不计）。
    elapsedMs: activeWithin(record.startedAt, end, c),
    waitedMs: (record.waitedMs ?? 0) + (waitingMs ?? 0),
    waitingMs,
    finished,
  };
}

/** 整次运行里等你回复的总时长；作废的记录不算。 */
export function runWaitedMs(records: readonly (TimedRecord & Pick<CanvasNodeSnapshot, "mark">)[], clock: number | RunClock): number {
  return records.reduce((sum, record) => record.mark === "superseded" ? sum : sum + (nodeTiming(record, clock)?.waitedMs ?? 0), 0);
}

/**
 * 整次运行真正在跑的时长：所有节点执行时段的并集（作废的也算，它们确实跑过）。
 * 运行停着、没有节点在跑的那段时间不计——停一天再继续，不会显示「用时 1 天」。
 * 正在跑的节点算到 `now`；被打断的节点不知道真实停在哪一刻，不计入
 * （否则会一直算到它被作废或运行最后结束）。
 */
export function runActiveMs(records: readonly Pick<CanvasNodeSnapshot, "startedAt" | "endedAt" | "status">[], now: number, active: boolean, clock?: RunClock): number {
  const within = (from: number, to: number) => (clock ? activeWithin(from, to, clock) : to - from);
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
      if (end > start) total += within(start, end);
      start = from;
      end = to;
    } else {
      end = Math.max(end, to);
    }
  }
  if (end > start) total += within(start, end);
  return total;
}
