import { describe, expect, it } from "vitest";
import { nodeTiming, runWaitedMs } from "../../../src/plugins/workflow/status/timing.ts";
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
    const running = { ...base, startedAt: 0, waitedMs: 2 * MIN, awaitingInput: true, awaitingInputSince: 8 * MIN };
    expect(nodeTiming(running, 10 * MIN)).toEqual({ startedAt: 0, elapsedMs: 10 * MIN, waitedMs: 4 * MIN, waitingMs: 2 * MIN, finished: false });
    const done = { ...base, status: "completed", startedAt: 0, endedAt: 5 * MIN, waitedMs: MIN, awaitingInputSince: 1 };
    expect(nodeTiming(done, 60 * MIN)).toMatchObject({ elapsedMs: 5 * MIN, waitedMs: MIN, waitingMs: null, finished: true });
    expect(nodeTiming(base, 0)).toBeNull();
  });

  it("整次运行的等待时长不算作废的记录", () => {
    const records = [
      { ...base, startedAt: 0, endedAt: MIN, waitedMs: 3 * MIN },
      { ...base, startedAt: 0, endedAt: MIN, waitedMs: 5 * MIN, mark: "superseded" },
      { ...base, startedAt: 0, waitedMs: MIN, awaitingInputSince: 9 * MIN },
    ];
    expect(runWaitedMs(records, 10 * MIN)).toBe(5 * MIN);
  });

  it("卡片说等了多久、已运行多久或用时", () => {
    expect(cardTime({ ...base, startedAt: 0, awaitingInputSince: 2 * MIN }, 5 * MIN)).toBe("等你 3 分钟");
    expect(cardTime({ ...base, startedAt: 0 }, 30_000)).toBe("已运行不到 1 分钟");
    expect(cardTime({ ...base, status: "completed", startedAt: 0, endedAt: 12 * MIN }, 99 * MIN)).toBe("用时 12 分钟");
    expect(cardTime(undefined, 0)).toBe("");
    expect(cardTime({ ...base, startedAt: 0 }, undefined)).toBe("");
    expect(durationPhrase("用时", -1)).toBe("");
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
