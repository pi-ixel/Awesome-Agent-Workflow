import type * as UsageService from "../../../../src/plugins/project/usage/service.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPerformance,
  performanceTool,
  performanceWait,
  performanceDurations,
  summarizePerformance,
  parsePerformance,
} from "../../../../src/plugins/project/conversation/sessionPerformance.ts";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import type { UserMessageItem } from "../../../../src/plugins/project/conversation/types.ts";
import type { PromptResult } from "../../../../src/contracts/acp/protocol.ts";

vi.mock(
  "../../../../src/plugins/project/usage/service.ts",
  async (original) => ({
    ...(await original<typeof UsageService>()),
    recordUsage: vi.fn(),
  }),
);

afterEach(() => vi.useRealTimers());
const user = (
  id: string,
  performance?: UserMessageItem["performance"],
): UserMessageItem => ({
  kind: "user",
  id,
  text: id,
  createdAt: "",
  performance,
});

describe("session performance accounting", () => {
  it("retains whole-session totals after the 200-item snapshot limit", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    await store.getState().setSessionLogTarget("performance-long");
    for (let i = 0; i < 205; i++) {
      vi.setSystemTime(i * 2000);
      store.getState().beginTurn(`turn ${i}`);
      vi.setSystemTime(i * 2000 + 1000);
      store.getState().endTurn({ stopReason: "end_turn", outputTokens: 100 });
    }
    await store.getState().setSessionLogTarget(null);
    const restored = createSessionStore();
    await restored.getState().restoreSessionLog("performance-long");
    expect(restored.getState().items).toHaveLength(200);
    expect(
      summarizePerformance(
        restored.getState().items,
        false,
        999999,
        restored.getState().performanceTotals,
      ),
    ).toMatchObject({ rounds: 205, modelMs: 205000, tps: 100 });
    vi.setSystemTime(999999);
    restored.getState().beginTurn("next");
    vi.setSystemTime(1000999);
    restored.getState().endTurn({ stopReason: "end_turn", outputTokens: 100 });
    expect(
      summarizePerformance(
        restored.getState().items,
        false,
        1000999,
        restored.getState().performanceTotals,
      ),
    ).toMatchObject({ rounds: 206, modelMs: 206000, tps: 100 });
    window.localStorage.clear();
  });

  it("does not resume interrupted timing after a binding replacement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createSessionStore();
    store.getState().beginTurn("lost connection");
    store
      .getState()
      .bindSession({
        prompt: () => Promise.resolve({ stopReason: "end_turn" }),
        cancel() {},
      });
    vi.setSystemTime(99999);
    store.getState().endTurn({ stopReason: "end_turn", outputTokens: 100 });
    expect(
      summarizePerformance(
        store.getState().items,
        false,
        99999,
        store.getState().performanceTotals,
      ),
    ).toMatchObject({ rounds: 1, tps: null, modelMs: null, ttftMs: null });
  });
  it.each(["turn", "turn-delta"] as const)(
    "uses %s output accounting across turns and a disk restore",
    async (accounting) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createSessionStore();
      const scope = `performance-${accounting}`;
      await store.getState().setSessionLogTarget(scope);
      let resolve!: (result: PromptResult) => void;
      store.getState().bindSession({
        promptUsageBasis: "prompt-total",
        cancel() {},
        usageScope: {
          workspace: "test",
          agent: accounting === "turn" ? "icode" : "codeagent",
          agentKey: "test",
          accounting,
          sessionId: () => "s",
        },
        prompt: () =>
          new Promise<PromptResult>((done) => {
            resolve = done;
          }),
      });
      store.setState({
        hasCumulativePromptUsage: accounting === "turn-delta",
        firstPromptPending: true,
      });
      store.getState().sendPrompt("one");
      vi.setSystemTime(2000);
      resolve({
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      });
      await Promise.resolve();
      vi.setSystemTime(3000);
      store.getState().sendPrompt("two");
      vi.setSystemTime(6000);
      resolve({
        stopReason: "end_turn",
        usage: {
          inputTokens: 2000,
          outputTokens: accounting === "turn" ? 600 : 800,
          totalTokens: 2800,
        },
      });
      await Promise.resolve();
      const stats = summarizePerformance(store.getState().items, false, 6000);
      expect(stats).toMatchObject({ modelMs: 4000, tps: 200, rounds: 2 });
      await store.getState().setSessionLogTarget(null);
      const restored = createSessionStore();
      await restored.getState().restoreSessionLog(scope);
      expect(
        summarizePerformance(restored.getState().items, false, 999999),
      ).toEqual(stats);
      window.localStorage.clear();
    },
  );

  it("keeps background session measurements separate when switching the foreground", async () => {
    const { createProjectForeground } =
      await import("../../../../src/plugins/project/conversation/foreground.ts");
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const a = createSessionStore(),
      b = createSessionStore();
    const foreground = createProjectForeground();
    foreground.select(a);
    a.getState().beginTurn("a");
    foreground.select(b);
    b.getState().beginTurn("b");
    vi.setSystemTime(2000);
    a.getState().endTurn({ stopReason: "end_turn", outputTokens: 100 });
    vi.setSystemTime(3000);
    b.getState().endTurn({ stopReason: "end_turn", outputTokens: 50 });
    expect(summarizePerformance(a.getState().items, false, 3000).tps).toBe(100);
    expect(summarizePerformance(b.getState().items, false, 3000).tps).toBe(25);
    foreground.dispose();
  });

  it("unions parallel tools, excludes user waits once, and ignores repeated terminal updates", () => {
    let p = beginPerformance(0);
    p = performanceTool(p, "a", "pending", 1000);
    p = performanceTool(p, "b", "in_progress", 2000);
    p = performanceWait(p, true, 2500);
    p = performanceTool(p, "a", "completed", 4000);
    p = performanceWait(p, false, 4500);
    p = performanceTool(p, "b", "failed", 6000);
    expect(performanceTool(p, "a", "in_progress", 7000)).toBe(p);
    expect(performanceDurations(p, 10000)).toEqual({
      modelMs: 5000,
      toolMs: 3000,
    });
  });

  it("weights average speed by eligible duration, excludes unknown output and unfinished turns", () => {
    const items = [
      user("a", {
        ...beginPerformance(0),
        endedAt: 1000,
        firstResponseAt: 200,
        outputTokens: 100,
      }),
      user("b", {
        ...beginPerformance(2000),
        endedAt: 11000,
        firstResponseAt: 3000,
        outputTokens: 900,
      }),
      user("c", { ...beginPerformance(12000), endedAt: 20000 }),
      user("old"),
      user("crashed", { ...beginPerformance(21000), firstResponseAt: 22000 }),
    ];
    expect(summarizePerformance(items, false, 50000)).toMatchObject({
      rounds: 5,
      modelMs: 18000,
      ttftMs: 600,
      tps: 100,
    });
    expect(summarizePerformance(items, true, 23000)).toMatchObject({
      modelMs: 20000,
      tps: 100,
    });
  });

  it("distinguishes missing metrics from real zero and rejects malformed snapshots", () => {
    expect(summarizePerformance([user("old")], false, 1000)).toMatchObject({
      modelMs: null,
      toolMs: null,
      ttftMs: null,
      tps: null,
    });
    expect(
      summarizePerformance(
        [
          user("zero", {
            ...beginPerformance(0),
            endedAt: 1000,
            outputTokens: 0,
          }),
        ],
        false,
        1000,
      ).tps,
    ).toBe(0);
    expect(
      parsePerformance({ ...beginPerformance(0), waits: [[10, 5]] }),
    ).toBeUndefined();
    expect(
      parsePerformance({ ...beginPerformance(0), outputTokens: -1 }),
    ).toBeUndefined();
  });

  it("collects thought TTFT and tools without a mounted UI, persists and restores the same results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createSessionStore();
    store.getState().beginTurn("hello");
    vi.setSystemTime(1200);
    store
      .getState()
      .handleEvent({ type: "agent_message_chunk", sessionId: "s", text: " " });
    vi.setSystemTime(1500);
    store.getState().handleEvent({
      type: "agent_thought_chunk",
      sessionId: "s",
      text: "thinking",
    });
    vi.setSystemTime(2000);
    store.getState().handleEvent({
      type: "tool_call",
      sessionId: "s",
      toolCallId: "t",
      title: "read",
      status: "in_progress",
    });
    vi.setSystemTime(3000);
    store.getState().setAwaitingUser(true);
    vi.setSystemTime(4000);
    store.getState().setAwaitingUser(false);
    vi.setSystemTime(5000);
    store.getState().handleEvent({
      type: "tool_call_update",
      sessionId: "s",
      toolCallId: "t",
      status: "completed",
    });
    vi.setSystemTime(6000);
    store.getState().endTurn({ stopReason: "cancelled", outputTokens: 200 });
    const items = store.getState().items;
    expect(summarizePerformance(items, false, 6000)).toMatchObject({
      rounds: 1,
      toolCalls: 1,
      modelMs: 2000,
      toolMs: 2000,
      ttftMs: 500,
      tps: 100,
    });
    const saved = JSON.parse(
      JSON.stringify(items.filter((i) => i.kind === "user")),
    ) as UserMessageItem[];
    const restored = restoreStoppedTurns([user("hello")], saved);
    expect(restored[0]).toMatchObject({ performance: saved[0]!.performance });
    expect(parsePerformance(saved[0]!.performance)).toEqual(
      saved[0]!.performance,
    );
    await store.getState().setSessionLogTarget(null);
  });

  it.each(["completed", "failed"])(
    "seals %s turns without output as time only",
    (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createSessionStore();
      store.getState().beginTurn("test");
      vi.setSystemTime(3000);
      store.getState().endTurn({
        stopReason: status === "completed" ? "end_turn" : null,
        ...(status === "failed" ? { errorMessage: "error" } : {}),
      });
      expect(
        summarizePerformance(store.getState().items, false, 10000),
      ).toMatchObject({ modelMs: 2000, ttftMs: null, tps: null });
    },
  );
});
