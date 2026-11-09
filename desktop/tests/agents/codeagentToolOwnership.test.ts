import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { expect, it } from "vitest";
import { createCodeAgentDialect } from "../../src/plugins/agents/enhancements/codeagent/dialect.ts";
import {
  attachSession,
  createSessionStore,
} from "../../src/plugins/project/conversation/sessionStore.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

it.each(["child-first", "main-first", "main-completed-first", "parent-last"])(
  "reconciles duplicate tools with %s ordering without losing standard-stream results",
  async (order) => {
    const peer = standardAcpPeer();
    const session = createOwnedSession(peer.client, {
      dialect: createCodeAgentDialect(),
    });
    const store = createSessionStore("ownership");
    const detach = attachSession(session, store);
    try {
      await session.initialize();
      await session.newSession("D:/test");
      const parent = () =>
        peer.update({
          sessionUpdate: "tool_call",
          toolCallId: "parent",
          title: "Explore",
          _meta: { codeAgentCLI: { toolName: "Agent" } },
        });
      const main = (completed = false) =>
        peer.update({
          sessionUpdate: completed ? "tool_call_update" : "tool_call",
          toolCallId: "child",
          title: "ToolSearch",
          status: completed ? "completed" : "pending",
          ...(completed
            ? { rawOutput: "main result", rawInput: { query: "docs" } }
            : { rawInput: {} }),
          _meta: { codeAgentCLI: { toolName: "ToolSearch" } },
        });
      const child = () =>
        peer.send({
          method: "_subagent/update",
          params: {
            sessionId: "same-session",
            taskId: "task",
            toolCallId: "parent",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "child",
              title: "ToolSearch",
              rawInput: {},
              status: "pending",
              _meta: { codeAgentCLI: { toolName: "ToolSearch" } },
            },
          },
        });
      if (order !== "parent-last") parent();
      peer.update({
        sessionUpdate: "tool_call",
        toolCallId: "main-only",
        title: "Bash",
        rawInput: { command: "pwd" },
      });
      if (order === "child-first") {
        child();
        main();
        main(true);
      } else if (order === "main-completed-first") {
        main();
        main(true);
        child();
      } else {
        main();
        child();
        main(true);
      }
      if (order === "parent-last") parent();
      const items = store.getState().items;
      const tools = items.filter((i) => i.kind === "tool");
      expect(tools.map((t) => t.toolCallId).sort()).toEqual([
        "main-only",
        "parent",
      ]);
      expect(
        tools.find((t) => t.toolCallId === "parent")?.subagent?.tools,
      ).toEqual([
        expect.objectContaining({
          name: "ToolSearch",
          state: "returned",
          input: { query: "docs" },
          output: "main result",
        }),
      ]);
      // Later top-level copies remain nested, including result-only updates.
      main(true);
      expect(
        store.getState().items.filter((i) => i.kind === "tool"),
      ).toHaveLength(2);
    } finally {
      detach();
      await sessionConnection(session).close();
    }
  },
);

it("does not apply vendor ownership rules to standard ACP", async () => {
  const peer = standardAcpPeer();
  const session = createOwnedSession(peer.client);
  const store = createSessionStore("standard-ownership");
  const detach = attachSession(session, store);
  try {
    await session.initialize();
    await session.newSession("D:/test");
    peer.send({
      method: "_subagent/update",
      params: {
        sessionId: "same-session",
        taskId: "task",
        toolCallId: "parent",
        update: { sessionUpdate: "tool_call", toolCallId: "child" },
      },
    });
    peer.update({
      sessionUpdate: "tool_call",
      toolCallId: "child",
      title: "Read",
    });
    expect(store.getState().items).toEqual([
      expect.objectContaining({ kind: "tool", toolCallId: "child" }),
    ]);
  } finally {
    detach();
    await sessionConnection(session).close();
  }
});

it("does not classify main tools by name or another session's child ID", () => {
  const d = createCodeAgentDialect();
  const event = {
    type: "tool_call" as const,
    sessionId: "s",
    toolCallId: "parent",
    _meta: { codeAgentCLI: { toolName: "Agent" } },
  };
  d.enhanceEvent!(event);
  d.translateNotification!("_subagent/update", {
    sessionId: "s",
    taskId: "task",
    toolCallId: "parent",
    update: { sessionUpdate: "tool_call", toolCallId: "child", title: "Read" },
  });
  expect(
    d.enhanceEvent!({
      ...event,
      toolCallId: "child",
      sessionId: "other",
      title: "Read",
    }),
  ).toMatchObject({
    type: "tool_call",
    toolCallId: "child",
    sessionId: "other",
  });
  expect(
    d.enhanceEvent!({
      ...event,
      toolCallId: "unrelated",
      title: "Read",
      _meta: { codeAgentCLI: { toolName: "Read" } },
    }),
  ).toMatchObject({ type: "tool_call", toolCallId: "unrelated" });
});

it("retains standard results when history establishes a missing parent association", () => {
  const d = createCodeAgentDialect();
  d.enhanceEvent!({
    type: "tool_call_update",
    sessionId: "s",
    toolCallId: "child",
    status: "completed",
    rawOutput: "result from standard stream",
  });
  d.translateNotification!("_subagent/update", {
    sessionId: "s",
    taskId: "task",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "child",
      status: "pending",
    },
  });
  expect(
    d.enhanceEvent!({
      type: "tool_call",
      sessionId: "s",
      toolCallId: "parent",
      _meta: { codeAgentCLI: { toolName: "Agent" } },
      rawOutput: { agentId: "task" },
    }),
  ).toMatchObject({
    absorbedToolCallIds: ["child"],
    subagent: {
      tools: [{ state: "returned", output: "result from standard stream" }],
    },
  });
});
