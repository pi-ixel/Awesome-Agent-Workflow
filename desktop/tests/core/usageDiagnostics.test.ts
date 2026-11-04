import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appLogSink } from "../../src/core/logger.ts";
import { createRuntimeStatusStore } from "../../src/stores/runtimeStatusStore.ts";
import { useLogStore } from "../../src/stores/logStore.ts";

beforeEach(() => {
  appLogSink.setLevel("info");
  appLogSink.clear();
});
afterEach(() => vi.useRealTimers());

it("10M/200k is retained in the diagnostic window with source, ratio and reason", () => {
  const store = createRuntimeStatusStore();
  store.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "internal-session",
    contextUsed: 10_000_000,
    contextSize: 200_000,
  });
  const entry = useLogStore.getState().entries.at(-1)!;
  expect(entry.channel).toBe("usage");
  expect(entry.level).toBe("warn");
  expect(entry.context).toMatchObject({
    sessionId: "internal-session",
    source: "standard",
    decision: "selected",
    used: 10_000_000,
    capacity: 200_000,
    calculatedPercent: 5000,
    reasons: ["used-exceeds-capacity"],
  });
});

it("records cumulative fallback and discarded notifications as separate evidence", () => {
  const store = createRuntimeStatusStore();
  store.getState().handleSessionEvent({
    type: "chrys_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      totalSessionTokens: 10_000_000,
      inputTokens: 123456,
      maxContextTokens: 200_000,
    },
  });
  expect(appLogSink.snapshot().at(-1)?.context).toMatchObject({
    source: "chrys",
    basis: "session-total-fallback",
    sessionTotal: 10_000_000,
    details: { input: 123456, reportedCapacity: 200_000 },
    reasons: ["cumulative-used-as-context", "used-exceeds-capacity"],
  });
  store.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "s",
    contextUsed: 5000,
    contextSize: 200_000,
  });
  expect(appLogSink.snapshot().at(-1)?.context.decision).toBe(
    "ignored-source-priority",
  );
  store.getState().handleSessionEvent({
    type: "chrys_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      usageSourceId: "child-1",
      totalTokens: 5000,
      maxContextTokens: 200_000,
    },
  });
  expect(appLogSink.snapshot().at(-1)?.context).toMatchObject({
    sourceId: "child-1",
    decision: "ignored-subagent",
  });
});

it("samples repeated updates but records anomalies and recovery immediately, reset clears sampling", () => {
  vi.useFakeTimers();
  const store = createRuntimeStatusStore();
  const send = (used: number) =>
    store.getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "s",
      contextUsed: used,
      contextSize: 200_000,
    });
  send(1000);
  send(2000);
  expect(appLogSink.snapshot()).toHaveLength(1);
  send(10_000_000);
  expect(appLogSink.snapshot()).toHaveLength(2);
  expect(appLogSink.snapshot().at(-1)?.context.sampledUpdates).toBe(1);
  send(11_000_000);
  vi.advanceTimersByTime(30_000);
  send(12_000_000);
  expect(appLogSink.snapshot().at(-1)?.context.used).toBe(12_000_000);
  send(3000);
  expect(appLogSink.snapshot().at(-1)?.level).toBe("info");
  store.getState().reset();
  send(3000);
  expect(appLogSink.snapshot()).toHaveLength(5);
});
