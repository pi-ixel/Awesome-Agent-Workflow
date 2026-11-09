import type { AcpSessionEvent } from "../../src/contracts/acpSession.ts";
import { selectSessionStore, useSessionStore as useCommandTestStore } from "../helpers/foreground.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/channelSession.ts";
import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createCodeAgentDialect,
  normalizePermission,
} from "../../src/plugins/agents/enhancements/codeagent/dialect.ts";
import { type AcpSession } from "../../src/plugins/acpRuntime/protocol/session.ts";
import { createSessionStore, attachSession } from "../../src/plugins/project/conversation/sessionStore.ts";
import { ModelTag, ModeTag } from "../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { parseSubagentPresentation } from "../../src/contracts/subagentTool.ts";
import { SubagentToolRow } from "../../src/plugins/project/conversation/ui/SubagentToolRow.tsx";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const meta = (name: string) => ({ codeAgentCLI: { toolName: name } });
const config = (model = "a", mode = "default") => [
  {
    id: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "a", name: "Alpha" },
      { value: "b", name: "Beta" },
    ],
  },
  {
    id: "mode",
    type: "select",
    currentValue: mode,
    options: [
      { value: "default", name: "默认" },
      { value: "plan", name: "计划" },
    ],
  },
];
async function fixture(
  enhanced = true,
  onElicitation?: NonNullable<
    ConstructorParameters<typeof AcpSession>[1]
  >["onElicitation"],
) {
  const f = standardAcpPeer();
  f.handlers.set("session/new", () => ({
    sessionId: "same-session",
    configOptions: config(),
  }));
  const session = createOwnedSession(f.client, {
    dialect: enhanced ? createCodeAgentDialect() : undefined,
    onElicitation,
  });
  const events: AcpSessionEvent[] = [];
  session.onEvent((event) => events.push(event));
  await session.initialize();
  await session.newSession("D:/test");
  return { ...f, session, events };
}
function tool(
  id = "parent",
  name = "Agent",
  sessionId = "s",
): Extract<AcpSessionEvent, { type: "tool_call" | "tool_call_update" }> {
  return {
    type: "tool_call",
    sessionId,
    toolCallId: id,
    title: "Task",
    kind: "think",
    status: "pending",
    rawInput: {},
    _meta: meta(name),
  };
}

it.each(["Read", "Bash", "TodoWrite", "AskUserQuestion"])(
  "does not infer %s as a subagent from title or think kind",
  (name) => {
    const d = createCodeAgentDialect();
    expect(d.enhanceEvent!(tool("t", name))).toMatchObject({ toolName: name });
    expect(d.enhanceEvent!(tool("t", name))).not.toHaveProperty("subagent");
    expect(
      normalizePermission({ _meta: meta(name), title: "Task" }),
    ).toHaveProperty("toolName", name);
  },
);

it("joins out-of-order child progress only to a proven parent and renders text/thought/tools", async () => {
  const f = await fixture();
  const store = createSessionStore("codeagent-dialect");
  const detach = attachSession(f.session, store);
  const child = (update: Record<string, unknown>, timestamp: number) =>
    f.send({
      method: "_subagent/update",
      params: {
        sessionId: "same-session",
        taskId: "task",
        toolCallId: "parent",
        agentType: "Explore",
        update,
        timestamp,
      },
    });
  try {
    child(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second" },
      },
      2,
    );
    child(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first " },
      },
      1,
    );
    child(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second" },
      },
      2,
    );
    expect(store.getState().items).toHaveLength(0);
    f.update({
      sessionUpdate: "tool_call",
      toolCallId: "parent",
      title: "Task",
      kind: "think",
      status: "pending",
      rawInput: {},
      _meta: meta("Agent"),
    });
    child(
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "considering" },
      },
      3,
    );
    child(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "read",
        status: "failed",
        rawOutput: "denied",
        _meta: meta("Read"),
      },
      5,
    );
    child(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read",
        status: "pending",
        rawInput: { path: "x.ts" },
        _meta: meta("Read"),
      },
      4,
    );
    const item = store.getState().items.find((item) => item.kind === "tool");
    if (item?.kind !== "tool" || !item.subagent)
      throw new Error("Expected normalized parent");
    expect(item.status).toBe("pending");
    expect(item.subagent.name).toBe("Explore");
    expect(item.subagent.task).toBe("");
    expect(item.subagent.messages?.map((message) => message.text)).toEqual([
      "first second",
      "considering",
    ]);
    expect(item.subagent.tools).toEqual([
      expect.objectContaining({
        name: "Read",
        state: "returned",
        failed: true,
        input: { path: "x.ts" },
        output: "denied",
      }),
    ]);
    expect(
      parseSubagentPresentation(JSON.parse(JSON.stringify(item.subagent))),
    ).toEqual(item.subagent);
    render(<SubagentToolRow item={item} agent={item.subagent} />);
    fireEvent.click(screen.getByText("子代理消息（2）"));
    expect(screen.getByText("first second")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /思考/ }));
    expect(screen.getByText("considering")).toBeVisible();
    fireEvent.click(screen.getByText("工具记录（1）"));
    expect(screen.getByText("Read")).toBeVisible();
    expect(screen.getByText("执行失败")).toBeVisible();
    f.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "parent",
      status: "completed",
      rawOutput: {
        agentType: "Explore",
        content: [{ type: "text", text: "done" }],
      },
    });
    child(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late" },
      },
      6,
    );
    expect(
      store.getState().items.find((item) => item.kind === "tool")?.status,
    ).toBe("completed");
  } finally {
    detach();
    await sessionConnection(f.session).close();
  }
});

it("recovers full parent input from history and keeps sessions/connections and orphans isolated", () => {
  const d = createCodeAgentDialect(),
    other = createCodeAgentDialect();
  d.translateNotification!("_subagent/update", {
    sessionId: "s",
    taskId: "agent-id",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "orphan evidence" },
    },
    timestamp: 1,
  });
  const history: AcpSessionEvent = {
    ...tool(),
    status: "completed",
    rawInput: { description: "inspect repo", subagent_type: "Explore" },
    rawOutput: {
      agentId: "agent-id",
      agentType: "Explore",
      content: [{ type: "text", text: "final" }],
    },
  };
  expect(d.enhanceEvent!(history)).toMatchObject({
    subagent: {
      task: "inspect repo",
      name: "Explore",
      messages: expect.arrayContaining([
        expect.objectContaining({ text: "orphan evidence" }),
        expect.objectContaining({ text: "final" }),
      ]) as unknown[],
    },
  });
  expect(other.enhanceEvent!(history)).toMatchObject({
    subagent: { messages: [expect.objectContaining({ text: "final" })] },
  });
  expect(
    d.enhanceEvent!({
      ...tool("parent", "Agent", "another"),
      status: "pending",
    }),
  ).toMatchObject({ subagent: { messages: [] } });
  expect(
    d.translateNotification!("_subagent/update", {
      sessionId: "s",
      taskId: "agent-id",
      toolCallId: "wrong",
      update: {},
    }),
  ).toBeNull();
  expect(
    d.translateNotification!("_subagent/update", {
      sessionId: "s",
      taskId: "missing",
      update: null,
    }),
  ).toBeNull();
});

it("the same private wire stays unknown without the enhancement", async () => {
  const a = await fixture(false),
    b = await fixture();
  try {
    for (const f of [a, b]) {
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "parent",
        title: "Task",
        kind: "think",
        _meta: meta("Agent"),
      });
      f.send({
        method: "_subagent/update",
        params: {
          sessionId: "same-session",
          taskId: "t",
          toolCallId: "parent",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child" },
          },
          timestamp: 1,
        },
      });
    }
    expect(a.events[0]).not.toHaveProperty("subagent");
    expect(a.events.at(-1)).toHaveProperty("type", "unknown_notification");
    expect(b.events.at(-1)).toMatchObject({
      type: "tool_call_update",
      subagent: { messages: [expect.objectContaining({ text: "child" })] },
    });
  } finally {
    await sessionConnection(a.session).close();
    await sessionConnection(b.session).close();
  }
});

it("normalizes model/mode catalogs and requires a matching confirmed result", async () => {
  const f = await fixture();
  try {
    expect(
      f.session.models?.availableModels.map((model) => model.modelId),
    ).toEqual(["a", "b"]);
    f.handlers.set("session/set_config_option", (wire) => ({
      configOptions: config(String(wire.params?.value)),
    }));
    await f.session.setModel("b", { timeoutMs: 100 });
    expect(f.session.models?.currentModelId).toBe("b");
    await expect(f.session.setModel("nonexistent")).rejects.toThrow("可选列表");
    expect(
      f.received.filter((wire) => wire.method === "session/set_config_option"),
    ).toHaveLength(1);
    f.handlers.set("session/set_config_option", () => ({
      configOptions: config("b"),
    }));
    await expect(f.session.setModel("a", { timeoutMs: 20 })).rejects.toThrow(
      "未确认",
    );
    expect(f.session.models?.currentModelId).toBe("b");
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("accepts notification acknowledgement before an empty response and rejects unavailable modes", async () => {
  const f = await fixture();
  try {
    f.handlers.set("session/set_config_option", (wire) => {
      f.update({
        sessionUpdate: "config_option_update",
        configOptions: config("a", String(wire.params?.value)),
      });
      return {};
    });
    await f.session.setMode("plan", { timeoutMs: 100 });
    expect(f.session.modes?.currentModeId).toBe("plan");
    await expect(f.session.setMode("bypassPermissions")).rejects.toThrow(
      "可选列表",
    );
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("falls back to legacy set_model only on method-not-found and waits for real confirmation", async () => {
  const f = await fixture();
  try {
    f.handlers.set("session/set_config_option", () => {
      throw Object.assign(new Error("unsupported"), {
        code: -32601,
        message: "unsupported",
      });
    });
    f.handlers.set("session/set_model", () => {
      f.update({
        sessionUpdate: "config_option_update",
        configOptions: config("b"),
      });
      return {};
    });
    await f.session.setModel("b", { timeoutMs: 100 });
    expect(f.session.models?.currentModelId).toBe("b");
    f.handlers.set("session/set_config_option", () => {
      throw Object.assign(new Error("invalid"), {
        code: -32602,
        message: "invalid",
      });
    });
    await expect(f.session.setModel("a")).rejects.toThrow("invalid");
    expect(
      f.received.filter((wire) => wire.method === "session/set_model"),
    ).toHaveLength(1);
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("a foreign-session update cannot confirm a model and pending confirmation cancels on disconnect", async () => {
  const f = await fixture();
  try {
    f.handlers.set("session/set_config_option", () => {
      f.update(
        { sessionUpdate: "config_option_update", configOptions: config("b") },
        "foreign",
      );
      return {};
    });
    await expect(f.session.setModel("b", { timeoutMs: 20 })).rejects.toThrow(
      "未确认",
    );
    expect(f.session.models?.currentModelId).toBe("a");
    const outcome = f.session
      .setModel("b", { timeoutMs: 1000 })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        f.received.filter(
          (wire) => wire.method === "session/set_config_option",
        ),
      ).toHaveLength(2),
    );
    f.peer.exit(1);
    expect(await outcome).toBeInstanceOf(Error);
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("reuses form UI responses, accepts legacy omitted form mode, and declines URLs/malformed schemas", async () => {
  const answer = vi.fn(() =>
    Promise.resolve({ action: "accept" as const, content: { name: "user" } }),
  );
  const f = await fixture(true, answer);
  try {
    expect(f.received[0]?.params?.clientCapabilities).toMatchObject({
      elicitation: { form: {} },
    });
    const form = {
      sessionId: "same-session",
      message: "Name?",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };
    expect((await f.request("elicitation/create", form)).result).toEqual({
      action: "accept",
      content: { name: "user" },
    });
    expect(
      (
        await f.request("elicitation/create", {
          mode: "url",
          message: "Login",
          url: "https://example.invalid",
          elicitationId: "u",
        })
      ).result,
    ).toEqual({ action: "decline" });
    expect(
      (
        await f.request("elicitation/create", {
          ...form,
          requestedSchema: null,
        })
      ).result,
    ).toEqual({ action: "decline" });
    expect(
      (await f.request("elicitation/create", { ...form, sessionId: "other" }))
        .result,
    ).toEqual({ action: "cancel" });
    expect(answer).toHaveBeenCalledTimes(1);
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("keeps parallel children with identical inner tool IDs on their own parent cards", () => {
  const d = createCodeAgentDialect();
  d.enhanceEvent!(tool("one"));
  d.enhanceEvent!(tool("two"));
  for (const [parent, text] of [
    ["one", "first"],
    ["two", "second"],
  ]) {
    const event = d.translateNotification!("_subagent/update", {
      sessionId: "s",
      taskId: parent,
      toolCallId: parent,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "same-inner-id",
        rawInput: { text },
        _meta: meta("Read"),
      },
      timestamp: 1,
    });
    expect(event).toMatchObject({
      type: "tool_call_update",
      toolCallId: parent,
      subagent: { tools: [expect.objectContaining({ input: { text } })] },
    });
  }
  const completed = d.enhanceEvent!({
    ...tool("one"),
    status: "completed",
    rawOutput: { content: [{ type: "text", text: "finished" }] },
  });
  expect(completed).toMatchObject({
    subagent: { messages: [expect.objectContaining({ text: "finished" })] },
  });
  expect(d.enhanceEvent!(tool("one"))).toHaveProperty("status", "completed");
});

it("preserves startup/load configuration notifications preceding their method responses", async () => {
  const f = standardAcpPeer();
  const session = createOwnedSession(f.client, {
    dialect: createCodeAgentDialect(),
  });
  try {
    await session.initialize();
    f.handlers.set("session/new", () => {
      f.update({
        sessionUpdate: "config_option_update",
        configOptions: config(),
      });
      return { sessionId: "same-session" };
    });
    await session.newSession("D:/test");
    expect(session.models?.currentModelId).toBe("a");
    f.handlers.set("session/load", () => {
      f.update(
        { sessionUpdate: "config_option_update", configOptions: config("b") },
        "restored",
      );
      return {};
    });
    const restored = createAcpSession(sessionConnection(session), { dialect: createCodeAgentDialect() });
    await restored.loadSession("restored", "D:/test");
    expect(restored.models?.currentModelId).toBe("b");
    f.update(
      { sessionUpdate: "config_option_update", configOptions: config("a") },
      "same-session",
    );
    expect(restored.models?.currentModelId).toBe("b");
  } finally {
    await sessionConnection(session).close();
  }
});

it("shows model acknowledgement as pending and reports false success without leaving the wrong model selected", async () => {
  const f = await fixture();
  const store = createSessionStore("codeagent-model-ui");
  const detach = attachSession(f.session, store);
  selectSessionStore(store);
  const view = render(<ModelTag />);
  try {
    f.handlers.set("session/set_config_option", () => ({}));
    act(() => store.getState().switchModel("b"));
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "正在确认模型",
    );
    act(() =>
      f.update({
        sessionUpdate: "config_option_update",
        configOptions: config("b"),
      }),
    );
    await waitFor(() => expect(store.getState().pendingModelId).toBeNull());
    expect(screen.getByRole("button", { name: "模型选择" })).toHaveTextContent(
      "Beta",
    );
    f.handlers.set("session/set_config_option", () => ({
      configOptions: config("b"),
    }));
    act(() => store.getState().switchModel("a"));
    await waitFor(() => expect(store.getState().pendingModelId).toBeNull(), {
      timeout: 3000,
    });
    expect(store.getState().currentModelId).toBe("b");
    expect(
      store
        .getState()
        .items.some(
          (item) =>
            item.kind === "system" && item.text.includes("模型切换失败"),
        ),
    ).toBe(true);
  } finally {
    view.unmount();
    detach();
    selectSessionStore(createSessionStore());
    await sessionConnection(f.session).close();
  }
});

it("does not apply a late config response from an old session to the newly loaded session", async () => {
  const f = await fixture();
  let reply: ((value: unknown) => void) | undefined;
  f.handlers.set(
    "session/set_config_option",
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const outcome = f.session.setModel("b").catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(reply).toBeDefined());
    f.handlers.set("session/load", () => ({ configOptions: config("a") }));
    await f.session.closeSession();
    const restored = createAcpSession(sessionConnection(f.session), { dialect: createCodeAgentDialect() });
    await restored.loadSession("new-target", "D:/test");
    reply!({ configOptions: config("b") });
    expect(await outcome).toBeInstanceOf(Error);
    expect(restored.models?.currentModelId).toBe("a");
  } finally {
    await sessionConnection(f.session).close();
  }
});

it("offers only the Agent-provided session modes and confirms changes in the mode menu", async () => {
  const f = await fixture();
  const store = createSessionStore("codeagent-mode-ui");
  const detach = attachSession(f.session, store);
  selectSessionStore(store);
  const view = render(<ModeTag />);
  try {
    expect(
      screen.getByRole("button", { name: "会话模式选择" }),
    ).toHaveTextContent("默认");
    f.handlers.set("session/set_config_option", () => ({}));
    fireEvent.click(screen.getByRole("button", { name: "会话模式选择" }));
    expect(screen.queryByText("bypassPermissions")).toBeNull();
    fireEvent.click(screen.getByText("计划"));
    expect(store.getState().pendingModeId).toBe("plan");
    act(() =>
      f.update({
        sessionUpdate: "config_option_update",
        configOptions: config("a", "plan"),
      }),
    );
    await waitFor(() => expect(store.getState().pendingModeId).toBeNull());
    expect(
      screen.getByRole("button", { name: "会话模式选择" }),
    ).toHaveTextContent("计划");
    f.handlers.set("session/set_config_option", () => {
      throw Object.assign(new Error("Mode not available"), { code: -32602 });
    });
    act(() => store.getState().switchMode("default"));
    await waitFor(() => expect(store.getState().pendingModeId).toBeNull());
    expect(store.getState().approvalMode?.id).toBe("plan");
    expect(
      store
        .getState()
        .items.some(
          (item) =>
            item.kind === "system" && item.text.includes("模式切换失败"),
        ),
    ).toBe(true);
  } finally {
    view.unmount();
    detach();
    selectSessionStore(createSessionStore());
    await sessionConnection(f.session).close();
  }
});

vi.mock("../../src/plugins/project/conversation/ui/useSessionCommands.ts", () => ({
  useSessionCommands: () => useCommandTestStore((state) => state),
}));

vi.mock("../../src/plugins/workbench/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../helpers/foreground.ts");
  return conversationViewFixture();
});
