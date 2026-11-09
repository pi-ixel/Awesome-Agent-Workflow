import { describe, expect, it } from "vitest";
import { createChrysDialect } from "../../src/plugins/agents/enhancements/icode/chrysDialect.ts";
import { parseSubagentPresentation } from "../../src/contracts/subagentTool.ts";

describe("ICode subagent lifecycle", () => {
  it("merges child tool evidence, handles duplicate and reordered messages, and restores details", () => {
    const dialect = createChrysDialect();
    const send = (suffix: string, extra = {}) =>
      dialect.translateNotification!(`_chrys/sub_agent_${suffix}`, {
        sessionId: "s",
        invocationId: "i",
        ...extra,
      });
    send("invocation_start", { parentCallId: "parent" });
    send("tool_call_result", {
      callId: "child",
      toolName: "read_file",
      result: "file contents",
      durationMs: 12,
      metadata: { code: 0 },
    });
    send("tool_call_start", {
      callId: "child",
      toolName: "read_file",
      args: { path: "a.ts" },
    });
    send("tool_call_start", {
      callId: "child",
      toolName: "read_file",
      args: { path: "a.ts" },
    });
    const event = dialect.enhanceEvent!({
      type: "tool_call_update",
      sessionId: "s",
      toolCallId: "parent",
      title: "explore_agent",
      status: "completed",
    });
    expect(event.type).toBe("tool_call_update");
    if (event.type !== "tool_call_update") throw new Error("wrong event");
    expect(event.subagent?.tools).toEqual([
      {
        id: JSON.stringify(["i", "child"]),
        name: "read_file",
        state: "returned",
        input: { path: "a.ts" },
        output: "file contents",
        durationMs: 12,
        metadata: { code: 0 },
      },
    ]);
    expect(
      parseSubagentPresentation(JSON.parse(JSON.stringify(event.subagent))),
    ).toEqual(event.subagent);
    send("invocation_start", { invocationId: "i2", parentCallId: "parent" });
    const second = send("tool_call_start", {
      invocationId: "i2",
      callId: "child",
      toolName: "shell",
      args: {},
    });
    if (second?.type !== "tool_call_update") throw new Error("wrong event");
    expect(second.subagent?.tools).toHaveLength(2);
  });
  it("updates the parent, preserves task evidence and leaves terminal status to ACP", () => {
    const dialect = createChrysDialect();
    dialect.enhanceEvent!({
      type: "tool_call",
      sessionId: "s",
      toolCallId: "parent",
      title: "explore_agent",
      rawInput: { prompt: "inspect repo" },
    });
    const send = (suffix: string, extra = {}) =>
      dialect.translateNotification!(`_chrys/sub_agent_${suffix}`, {
        sessionId: "s",
        invocationId: "i",
        agentName: "Explore",
        ...extra,
      });
    expect(send("invocation_start", { parentCallId: "parent" })).toMatchObject({
      type: "tool_call_update",
      toolCallId: "parent",
      subagent: { task: "inspect repo", phase: "running" },
    });
    const paused = send("paused", {
      reason: "approval",
      lastError: "retry exhausted",
    });
    expect(paused).toMatchObject({
      subagent: { phase: "paused", detail: "approval；retry exhausted" },
    });
    const standard = dialect.enhanceEvent!({
      type: "tool_call_update",
      sessionId: "s",
      toolCallId: "parent",
      status: "in_progress",
    });
    expect(standard).toMatchObject({
      subagent: { phase: "paused", task: "inspect repo" },
    });
    expect(send("retry_attempt", { message: "retry" })).toMatchObject({
      subagent: { phase: "retrying" },
    });
    expect(send("resumed")).toMatchObject({
      subagent: { phase: "running", detail: "" },
    });
    const aborted = send("aborted", { lastError: "cancelled" });
    expect(aborted).toMatchObject({ subagent: { phase: "aborted" } });
    expect(aborted).not.toHaveProperty("status");
    if (aborted?.type === "tool_call_update")
      expect(parseSubagentPresentation(aborted.subagent)).toEqual(
        aborted.subagent,
      );
  });
  it("isolates sessions and retains unassociated notifications without inventing tools", () => {
    const dialect = createChrysDialect();
    const send = (sessionId: string, method: string, extra = {}) =>
      dialect.translateNotification!(`_chrys/sub_agent_${method}`, {
        sessionId,
        invocationId: "same",
        ...extra,
      });
    send("a", "invocation_start", { parentCallId: "parent-a" });
    expect(send("b", "paused")).toMatchObject({ type: "agent_extension" });
    send("b", "invocation_start", { parentCallId: "parent-b" });
    expect(send("a", "cascade_aborted")).toMatchObject({
      toolCallId: "parent-a",
      subagent: { phase: "aborted" },
    });
    expect(send("b", "resumed")).toMatchObject({
      toolCallId: "parent-b",
      subagent: { phase: "running" },
    });
    expect(send("a", "tool_call_start", { callId: "nested" })).toMatchObject({
      type: "agent_extension",
    });
  });
});
