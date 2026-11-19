import type { SessionItem } from "./types.ts";

type Interval = readonly [number, number | null];
export interface TurnPerformance {
  readonly interrupted?: true;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly firstResponseAt: number | null;
  readonly tools: Readonly<Record<string, Interval>>;
  readonly waits: readonly Interval[];
  readonly outputTokens?: number;
}

export function beginPerformance(now: number): TurnPerformance {
  return {
    startedAt: now,
    endedAt: null,
    firstResponseAt: null,
    tools: {},
    waits: [],
  };
}

export function performanceTool(
  value: TurnPerformance,
  id: string,
  status: string | undefined,
  now: number,
): TurnPerformance {
  const previous = value.tools[id];
  if (previous?.[1] != null) return value;
  const finished = status === "completed" || status === "failed";
  return {
    ...value,
    tools: {
      ...value.tools,
      [id]: [previous?.[0] ?? now, finished ? now : null],
    },
  };
}

export function performanceWait(
  value: TurnPerformance,
  waiting: boolean,
  now: number,
): TurnPerformance {
  const waits = [...value.waits];
  const last = waits.at(-1);
  if (waiting && (!last || last[1] !== null)) waits.push([now, null]);
  if (!waiting && last?.[1] === null) waits[waits.length - 1] = [last[0], now];
  return { ...value, waits };
}

function unionDuration(
  intervals: readonly Interval[],
  start: number,
  end: number,
): number {
  const sorted = intervals
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b ?? end)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let cursor = start;
  let duration = 0;
  for (const [a, b] of sorted) {
    duration += Math.max(0, b - Math.max(cursor, a));
    cursor = Math.max(cursor, b);
  }
  return duration;
}

export function performanceDurations(value: TurnPerformance, now: number) {
  const end = value.endedAt ?? now;
  const tools = Object.values(value.tools);
  const waitMs = unionDuration(value.waits, value.startedAt, end);
  const excludedMs = unionDuration(
    [...tools, ...value.waits],
    value.startedAt,
    end,
  );
  return {
    modelMs: Math.max(0, end - value.startedAt - excludedMs),
    toolMs: excludedMs - waitMs,
  };
}

/** Persisted unfinished turns never resume their clock after an app restart. */
export function collectPerformance(
  items: readonly SessionItem[],
  running: boolean,
  now: number,
) {
  const users = items.filter((item) => item.kind === "user");
  let modelMs = 0,
    toolMs = 0,
    measured = 0,
    responseMs = 0,
    responses = 0,
    output = 0,
    outputMs = 0;
  let toolCalls = 0;
  let ids = new Set<string>();
  for (const item of items) {
    if (item.kind === "user") ids = new Set();
    if (item.kind === "tool" && !ids.has(item.toolCallId)) {
      ids.add(item.toolCallId);
      toolCalls++;
    }
  }
  for (const user of users) {
    const value = user.performance;
    if (
      !value ||
      value.interrupted ||
      (value.endedAt === null && !(running && user === users.at(-1)))
    )
      continue;
    const duration = performanceDurations(value, now);
    measured++;
    modelMs += duration.modelMs;
    toolMs += duration.toolMs;
    if (value.firstResponseAt !== null) {
      responseMs += value.firstResponseAt - value.startedAt;
      responses++;
    }
    if (
      value.endedAt !== null &&
      value.outputTokens !== undefined &&
      duration.modelMs > 0
    ) {
      output += value.outputTokens;
      outputMs += duration.modelMs;
    }
  }
  return {
    rounds: users.length,
    toolCalls,
    modelMs,
    toolMs,
    measured,
    responseMs,
    responses,
    output,
    outputMs,
  };
}

export type PerformanceTotals = ReturnType<typeof collectPerformance>;
export function addPerformance(
  a: PerformanceTotals,
  b: PerformanceTotals,
): PerformanceTotals {
  return Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      a[key as keyof PerformanceTotals] + b[key as keyof PerformanceTotals],
    ]),
  ) as PerformanceTotals;
}
export function currentTurnItems(
  items: readonly SessionItem[],
): readonly SessionItem[] {
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i]?.kind === "user") return items.slice(i);
  return [];
}
export function summarizePerformance(
  items: readonly SessionItem[],
  running: boolean,
  now: number,
  totals?: PerformanceTotals,
) {
  const v = totals
    ? running
      ? addPerformance(
          totals,
          collectPerformance(currentTurnItems(items), true, now),
        )
      : totals
    : collectPerformance(items, running, now);
  return {
    rounds: v.rounds,
    toolCalls: v.toolCalls,
    modelMs: v.measured ? v.modelMs : null,
    toolMs: v.measured ? v.toolMs : null,
    ttftMs: v.responses ? v.responseMs / v.responses : null,
    tps: v.outputMs ? (v.output * 1000) / v.outputMs : null,
  };
}
export function parsePerformanceTotals(
  raw: unknown,
): PerformanceTotals | undefined {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(collectPerformance([], false, 0));
  if (
    !keys.every(
      (key) =>
        typeof record[key] === "number" &&
        Number.isFinite(record[key]) &&
        record[key] >= 0,
    )
  )
    return;
  return Object.fromEntries(
    keys.map((key) => [key, record[key]]),
  ) as PerformanceTotals;
}

export function parsePerformance(raw: unknown): TurnPerformance | undefined {
  if (!raw || typeof raw !== "object") return;
  const r = raw as TurnPerformance;
  const number = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  const interval = (v: unknown): v is Interval =>
    Array.isArray(v) &&
    v.length === 2 &&
    number(v[0]) &&
    (v[1] === null || (number(v[1]) && v[1] >= v[0]));
  if (
    !number(r.startedAt) ||
    !(r.endedAt === null || (number(r.endedAt) && r.endedAt >= r.startedAt)) ||
    !(
      r.firstResponseAt === null ||
      (number(r.firstResponseAt) && r.firstResponseAt >= r.startedAt)
    ) ||
    !r.tools ||
    typeof r.tools !== "object" ||
    !Object.values(r.tools).every(interval) ||
    !Array.isArray(r.waits) ||
    !r.waits.every(interval) ||
    (r.outputTokens !== undefined && !number(r.outputTokens))
  )
    return;
  return r;
}
