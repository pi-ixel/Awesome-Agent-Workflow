import type { AcpSessionEvent } from "../../../src/plugins/acpRuntime/events.ts";
import { createOwnedSession, sessionConnection } from "../../helpers/ownedSession.ts";
import { expect, it } from "vitest";
import { createChrysDialect } from "../../../src/plugins/agents/enhancements/icode/chrysDialect.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

async function pair() {
  const make = async (enhanced: boolean) => {
    const peer = standardAcpPeer();
    const session = createOwnedSession(peer.client, {
      dialect: enhanced ? createChrysDialect() : undefined,
    });
    const events: AcpSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    await session.initialize();
    await session.newSession("D:/fixture");
    return { ...peer, session, events };
  };
  return Promise.all([make(false), make(true)]);
}

it("the identical standard wire has identical meaning with and without a dialect", async () => {
  const fixtures = await pair();
  try {
    for (const f of fixtures) {
      f.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "standard" },
      });
      f.update({
        sessionUpdate: "session_info_update",
        title: "Server title",
        updatedAt: "2026-11-05T10:00:00Z",
      });
      f.update({
        sessionUpdate: "usage_update",
        used: 50,
        size: 200,
        cost: { amount: 0.01, currency: "USD" },
      });
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "standard",
        title: "Read file",
        kind: "read",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "result" } },
        ],
      });
    }
    const protocolEvents = (events: readonly AcpSessionEvent[]) =>
      events.map((event) => {
        if (!("receivedAt" in event)) return event;
        const { receivedAt, ...payload } = event;
        expect(Number.isFinite(receivedAt)).toBe(true);
        return payload;
      });
    expect(protocolEvents(fixtures[0].events)).toEqual(
      protocolEvents(fixtures[1].events),
    );
    expect(fixtures[0].events.map((event) => event.type)).toEqual([
      "agent_message_chunk",
      "session_info_update",
      "usage_update",
      "tool_call",
    ]);
  } finally {
    await Promise.all(fixtures.map((f) => sessionConnection(f.session).close()));
  }
});

it("private usage/warnings and edit/subagent inference only apply to the enhanced peer", async () => {
  const fixtures = await pair();
  try {
    for (const f of fixtures) {
      f.send({
        method: "_chrys/warning",
        params: { sessionId: "same-session", message: "private warning" },
      });
      f.send({
        method: "_chrys/usage_update",
        params: {
          sessionId: "same-session",
          totalTokens: 25,
          maxContextTokens: 200,
        },
      });
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "sub",
        title: "explore_agent",
        rawInput: { prompt: "inspect" },
        status: "in_progress",
      });
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "edit",
        title: "edit_file",
        kind: "edit",
        rawInput: { path: "x.ts", old_string: "a", new_string: "b" },
      });
    }
    const standard = fixtures[0].events;
    const enhanced = fixtures[1].events;
    expect(standard.slice(0, 2).map((event) => event.type)).toEqual([
      "unknown_notification",
      "unknown_notification",
    ]);
    expect(enhanced.slice(0, 2).map((event) => event.type)).toEqual([
      "agent_warning",
      "agent_usage",
    ]);
    expect(standard[2]).not.toHaveProperty("subagent");
    expect(standard[3]).not.toHaveProperty("edit");
    expect(enhanced[2]).toHaveProperty("subagent.task", "inspect");
    expect(enhanced[3]).toHaveProperty("edit.path", "x.ts");
  } finally {
    await Promise.all(fixtures.map((f) => sessionConnection(f.session).close()));
  }
});

it("identical cancelled permission is only rewritten by ICode", async () => {
  const fixtures = await pair();
  try {
    const responses = await Promise.all(
      fixtures.map((f) =>
        f.request("session/request_permission", {
          sessionId: "same-session",
          toolCall: { toolCallId: "t", title: "Run", status: "pending" },
          options: [{ optionId: "no", name: "Reject", kind: "reject_once" }],
        }),
      ),
    );
    expect(responses[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(responses[1]?.result).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });
  } finally {
    await Promise.all(fixtures.map((f) => sessionConnection(f.session).close()));
  }
});

it("malformed private payloads cannot poison subsequent standard output", async () => {
  const fixtures = await pair();
  try {
    for (const f of fixtures) {
      f.send({
        method: "_chrys/runtime_update",
        params: { sessionId: "same-session", runtime: "invalid" },
      });
      f.send({
        method: "_chrys/usage_update",
        params: { totalTokens: "invalid" },
      });
      await expect(f.session.prompt("continue")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
      // 末位事件是协议层本地的 turn_ended（prompt 响应返回）；内容事件在其前。
      const contentEvents = f.events.filter(
        (event) => event.type !== "turn_started" && event.type !== "turn_ended",
      );
      expect(contentEvents.at(-1)).toMatchObject({
        type: "agent_message_chunk",
        text: "standard reply",
      });
      expect(
        f.events.some(
          (event) =>
            event.type === "agent_runtime" || event.type === "agent_usage",
        ),
      ).toBe(false);
    }
  } finally {
    await Promise.all(fixtures.map((f) => sessionConnection(f.session).close()));
  }
});
