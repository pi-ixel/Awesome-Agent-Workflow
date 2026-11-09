import { describe, expect, it, beforeEach } from "vitest";
import { createChrysDialect } from "../../src/plugins/agents/enhancements/icode/chrysDialect.ts";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import { parseSubagentPresentation } from "../../src/contracts/subagentTool.ts";

function fixture() {
  const dialect = createChrysDialect();
  const send = (method: string, fields: Record<string, unknown> = {}) =>
    dialect.translateNotification!(`_chrys/sub_agent_${method}`, {
      sessionId: "s",
      invocationId: "i",
      agentName: "Explore",
      ...fields,
    });
  send("invocation_start", { parentCallId: "parent" });
  const presentation = () => {
    const event = dialect.enhanceEvent!({
      type: "tool_call_update",
      sessionId: "s",
      toolCallId: "parent",
      title: "explore_agent",
    });
    if (event.type !== "tool_call_update") throw new Error("Unexpected event");
    return event.subagent!;
  };
  return { dialect, send, presentation };
}

beforeEach(() => localStorage.clear());

describe("ICode subagent progress and compaction", () => {
  it("separates current context from spend and preserves partial progress without fabricating zeros", () => {
    const { send, presentation } = fixture();
    send("progress", {
      toolCallCount: 3,
      totalTokens: 90,
      totalUsageTokens: 1500,
      usageUnreportedAttempts: 2,
    });
    expect(presentation().progress).toEqual({
      id: "i",
      toolCalls: 3,
      contextTokens: 90,
      totalTokens: 1500,
      unreportedAttempts: 2,
    });
    send("paused", { reason: "waiting" });
    send("progress", {
      totalTokens: 30,
      totalUsageTokens: -1,
      toolCallCount: "4",
    });
    expect(presentation()).toMatchObject({
      phase: "paused",
      progress: { toolCalls: 3, contextTokens: 30, totalTokens: 1500 },
    });
    expect(send("progress", { totalTokens: NaN })).toMatchObject({
      type: "agent_extension",
    });
    send("invocation_start", { invocationId: "next", parentCallId: "parent" });
    send("progress", { invocationId: "next", toolCallCount: 0 });
    expect(presentation().progress).toEqual({ id: "next", toolCalls: 0 });
  });

  it("requires commit confirmation and deduplicates reordered compaction notifications", () => {
    const { send, presentation } = fixture();
    const fields = { compactionId: "c", phase: "phase4" };
    send("compaction_started", fields);
    expect(presentation().compactions?.[0]?.state).toBe("running");
    send("compaction_finished", {
      ...fields,
      outcome: "ok",
      durationMs: 10,
      formatViolation: "missing section",
    });
    expect(presentation().compactions?.[0]?.state).toBe("awaiting_commit");
    send("compaction_started", fields);
    expect(presentation().compactions?.[0]?.state).toBe("awaiting_commit");
    send("compaction_committed", fields);
    send("compaction_committed", fields);
    send("compaction_finished", { ...fields, outcome: "ok", durationMs: 12 });
    expect(presentation().compactions).toHaveLength(1);
    expect(presentation().compactions?.[0]).toMatchObject({
      state: "committed",
      durationMs: 12,
      warning: "missing section",
    });
    send("compaction_committed", { compactionId: "commit-first" });
    send("compaction_started", { compactionId: "commit-first" });
    expect(presentation().compactions?.[1]?.state).toBe("committed");
  });

  it("retains failures, unknown outcomes, and isolates identical IDs across sessions and invocations", () => {
    const { send, presentation } = fixture();
    send("compaction_finished", {
      compactionId: "c",
      outcome: "failed",
      failureReason: "spill write failed",
      durationMs: 0,
    });
    send("compaction_started", { compactionId: "c" });
    expect(presentation().compactions?.[0]).toMatchObject({
      state: "failed",
      failureReason: "spill write failed",
      durationMs: 0,
    });
    send("invocation_start", { invocationId: "other", parentCallId: "parent" });
    send("compaction_finished", {
      invocationId: "other",
      compactionId: "c",
      outcome: "future-outcome",
    });
    expect(presentation().compactions).toHaveLength(2);
    expect(presentation().compactions?.[1]).toMatchObject({
      state: "finished",
      outcome: "future-outcome",
    });
    expect(
      send("progress", { sessionId: "unknown", toolCallCount: 50 }),
    ).toMatchObject({ type: "agent_extension" });
    expect(send("compaction_started", { compactionId: "" })).toMatchObject({
      type: "agent_extension",
    });
  });

  it("persists normalized telemetry and does not change the parent terminal status", () => {
    const { send, presentation } = fixture();
    const store = createSessionStore("icode");
    store.getState().setSessionLogTarget("project#s");
    store.getState().handleEvent({
      type: "tool_call",
      sessionId: "s",
      toolCallId: "parent",
      title: "delegate",
      status: "completed",
    });
    send("progress", {
      toolCallCount: 5,
      totalTokens: 100,
      totalUsageTokens: 2000,
      usageUnreportedAttempts: 1,
    });
    const event = send("compaction_finished", {
      compactionId: "c",
      outcome: "ok",
    })!;
    if (event.type !== "tool_call_update") throw new Error("Unexpected event");
    expect(event).not.toHaveProperty("status");
    store.getState().handleEvent(event);
    store.getState().flushSessionLog();
    const reopened = createSessionStore("icode");
    reopened.getState().restoreSessionLog("project#s");
    expect(reopened.getState().items[0]).toMatchObject({
      status: "completed",
      subagent: event.subagent,
    });
    expect(
      parseSubagentPresentation({
        ...presentation(),
        progress: { id: "i", toolCalls: -1 },
        compactions: [{ id: "bad", state: "fake" }],
      }),
    ).toMatchObject({ progress: { id: "i" }, compactions: [] });
  });
});
