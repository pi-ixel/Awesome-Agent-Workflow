import { describe, expect, it } from "vitest";
import { nodeTiming, runActiveMs, runClock, runWaitedMs } from "../../../src/plugins/workflow/status/timing.ts";
import { cardTime } from "../../../src/plugins/workflow/ui/nodeText.ts";
import { durationPhrase } from "../../../src/plugins/workflow/ui/time.ts";
import { deriveCanvasSnapshot } from "../../../src/plugins/workflow/status/snapshot.ts";
import type { CanvasNodeSnapshot } from "../../../src/plugins/workflow/types.ts";

const MIN = 60_000;
const base: CanvasNodeSnapshot = {
  siteId: "ask#1", ordinal: 1, kind: "ask", status: "running", scope: {}, callPath: [], phaseId: "design",
  actorSiteId: "", actorOrdinal: 0, result: null, candidates: [],
};

describe("节点用时", () => {
  it("执行中按现在计算，结束后按结束时间计算，等待时长含正在进行的等待", () => {
    const running = { ...base, startedAt: 0, waitedMs: 2 * MIN, turn: "completed", turnEndedAt: 8 * MIN };
    expect(nodeTiming(running, 10 * MIN)).toEqual({ startedAt: 0, elapsedMs: 10 * MIN, waitedMs: 4 * MIN, waitingMs: 2 * MIN, finished: false });
    const done = { ...base, status: "completed", startedAt: 0, endedAt: 5 * MIN, waitedMs: MIN, turn: "completed", turnEndedAt: 1 };
    // 这一轮还在跑：不算在等。
    expect(nodeTiming({ ...running, turn: "working" }, 10 * MIN)).toMatchObject({ waitedMs: 2 * MIN, waitingMs: null });
    expect(nodeTiming(done, 60 * MIN)).toMatchObject({ elapsedMs: 5 * MIN, waitedMs: MIN, waitingMs: null, finished: true });
    expect(nodeTiming(base, 0)).toBeNull();
  });

  it("整次运行的等待时长不算作废的记录", () => {
    const records = [
      { ...base, startedAt: 0, endedAt: MIN, waitedMs: 3 * MIN },
      { ...base, startedAt: 0, endedAt: MIN, waitedMs: 5 * MIN, mark: "superseded" },
      { ...base, startedAt: 0, waitedMs: MIN, turn: "cancelled", turnEndedAt: 9 * MIN },
    ];
    expect(runWaitedMs(records, 10 * MIN)).toBe(5 * MIN);
  });

  it("卡片说等了多久、已运行多久或用时", () => {
    expect(cardTime({ ...base, startedAt: 0, turn: "completed", turnEndedAt: 2 * MIN }, 5 * MIN)).toBe("等你 3 分钟");
    expect(cardTime({ ...base, startedAt: 0 }, 30_000)).toBe("已运行不到 1 分钟");
    expect(cardTime({ ...base, status: "completed", startedAt: 0, endedAt: 12 * MIN }, 99 * MIN)).toBe("用时 12 分钟");
    expect(cardTime(undefined, 0)).toBe("");
    expect(cardTime({ ...base, startedAt: 0 }, undefined)).toBe("");
    expect(durationPhrase("用时", -1)).toBe("");
  });

  it("运行停着的时间不计：停着时截止到停下那一刻，继续后的等待从继续时算起", () => {
    const waiting = { ...base, startedAt: 0, waitedMs: 2 * MIN, turn: "completed", turnEndedAt: MIN };
    const stopped = { now: 60 * MIN, active: false, activeSince: null, stoppedAt: 4 * MIN, spans: [] };
    // 停着：不再说「等你」，用时停在停下那一刻；之前的等待已由引擎计入。
    expect(nodeTiming(waiting, stopped)).toMatchObject({ waitingMs: null, elapsedMs: 4 * MIN, waitedMs: 2 * MIN });
    expect(cardTime(waiting, stopped)).toBe("用时 4 分钟");
    // 继续运行（第 50 分钟起）：这次等待从继续那一刻算，停着的 46 分钟不算。
    const resumed = { now: 53 * MIN, active: true, activeSince: 50 * MIN, stoppedAt: null, spans: [] };
    expect(nodeTiming(waiting, resumed)).toMatchObject({ waitingMs: 3 * MIN, waitedMs: 5 * MIN });
    expect(runClock({ active: false, run: { stoppedAt: 7, updatedAt: 9 } as never }, 10)).toEqual({ now: 10, active: false, activeSince: null, stoppedAt: 7, spans: [] });
  });

  it("用时也只算执行时段：停着的那段不计；刚继续、新时段还没推到时不闪出停着的时间", () => {
    // 0–4 分钟在执行，4–50 分钟停着，50 分钟起继续。
    const spans = [[0, 4 * MIN], [50 * MIN, null]] as const;
    const resumed = { now: 53 * MIN, active: true, activeSince: 50 * MIN, stoppedAt: null, spans };
    const waiting = { ...base, startedAt: 0, waitedMs: 2 * MIN, turn: "completed", turnEndedAt: MIN };
    expect(nodeTiming(waiting, resumed)).toMatchObject({ elapsedMs: 7 * MIN, waitingMs: 3 * MIN });
    expect(runActiveMs([waiting], 53 * MIN, true, resumed)).toBe(7 * MIN);
    // 推送还没到：快照已在执行，但执行时段仍是停着时的那份。
    const stale = runClock({ active: true, run: { spans: [[0, 4 * MIN]] } as never }, 50 * MIN);
    expect(stale.activeSince).toBe(50 * MIN);
    expect(nodeTiming(waiting, stale)?.waitingMs).toBe(0);
  });

  it("快照解析引擎给的时间字段", () => {
    const snapshot = deriveCanvasSnapshot({
      run: { runId: "r", status: "running" },
      nodes: [{ siteId: "ask#1", ordinal: 1, status: "running", startedAt: 10, endedAt: 20, waitedMs: 5 }, { siteId: "ask#2", ordinal: 1, status: "running" }],
    });
    expect(snapshot.nodes[0]).toMatchObject({ startedAt: 10, endedAt: 20, waitedMs: 5 });
    expect(snapshot.nodes[1]).not.toHaveProperty("startedAt");
  });
});
