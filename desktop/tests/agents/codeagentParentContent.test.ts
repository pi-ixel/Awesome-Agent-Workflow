import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { expect, it } from "vitest";
import { createCodeAgentDialect } from "../../src/agents/codeagent/dialect.ts";
import {
  attachSession,
  createSessionStore,
} from "../../src/stores/sessionStore.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const parent = {
  type: "tool_call" as const,
  sessionId: "s",
  toolCallId: "parent",
  title: "Task",
  rawInput: {},
  _meta: { codeAgentCLI: { toolName: "Agent" } },
};
it("uses the supplied completed parent title and standard content without inventing child ownership", async () => {
  const peer = standardAcpPeer();
  const session = createOwnedSession(peer.client, {
    dialect: createCodeAgentDialect(),
  });
  const store = createSessionStore("parent-content");
  const detach = attachSession(session, store);
  try {
    await session.initialize();
    await session.newSession("D:/test");
    peer.update({ ...parent, sessionUpdate: "tool_call" });
    peer.update({
      sessionUpdate: "tool_call",
      toolCallId: "bash",
      title: "find . -type f | wc -l",
      rawInput: { command: "find . -type f | wc -l" },
      _meta: { codeAgentCLI: { toolName: "Bash" } },
    });
    peer.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "parent",
      title: "统计 desktop 目录文件数",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "统计完成，共 619 个文件。" },
        },
      ],
      _meta: parent._meta,
    });
    const tools = store.getState().items.filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.toolCallId === "parent")).toMatchObject({
      rawInput: {},
      subagent: {
        task: "统计 desktop 目录文件数",
        tools: [],
        messages: [{ kind: "message", text: "统计完成，共 619 个文件。" }],
      },
    });
  } finally {
    detach();
    await sessionConnection(session).close();
  }
});

it.each(["Task", "Agent", "spawn_agent", "", "parent"])(
  "does not use placeholder title %s as a task description",
  (title) => {
    expect(
      createCodeAgentDialect().enhanceEvent!({ ...parent, title }),
    ).toMatchObject({ subagent: { task: "" } });
  },
);

it.each([
  [
    { description: "original description", prompt: "original prompt" },
    "original description",
  ],
  [{ description: "  ", prompt: "original prompt" }, "original prompt"],
  [{ description: "", prompt: "" }, "具体任务"],
])(
  "prefers meaningful original parameters over title: %j",
  (rawInput, task) => {
    expect(
      createCodeAgentDialect().enhanceEvent!({
        ...parent,
        title: "具体任务",
        rawInput,
      }),
    ).toMatchObject({ subagent: { task } });
  },
);

it("keeps legacy rawOutput precedence and falls back to content for an empty rawOutput object", () => {
  const content = [
    { type: "content", content: { type: "text", text: "standard result" } },
  ];
  expect(
    createCodeAgentDialect().enhanceEvent!({
      ...parent,
      rawOutput: { content: [{ type: "text", text: "legacy result" }] },
      content,
    }),
  ).toMatchObject({ subagent: { messages: [{ text: "legacy result" }] } });
  expect(
    createCodeAgentDialect().enhanceEvent!({
      ...parent,
      rawOutput: {},
      content,
    }),
  ).toMatchObject({ subagent: { messages: [{ text: "standard result" }] } });
});
