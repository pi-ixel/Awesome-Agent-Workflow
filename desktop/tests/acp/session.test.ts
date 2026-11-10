import type { AcpSessionEvent } from "../../src/plugins/acpRuntime/events.ts";
import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
/**
 * 会话层（src/acp/session.ts）× 仿真 agent（mock/echo-agent.ts）：
 * 握手与版本协商、会话生命周期、通知流派发为类型化事件、取消、
 * 反向请求（权限 / 结构化提问）。
 *
 * 事件夹具形状对照 skill-eval/tests/test_acp_events.py 的 wire 样本
 * （tool_call / tool_call_update / 嵌套 content）。
 */

import { describe, expect, it } from "vitest";

import {
  AcpResponseError,
  AcpTimeoutError,
} from "../../src/plugins/acpRuntime/service.ts";
import { AcpHandshakeError } from "../../src/plugins/acpRuntime/protocol/handshakeError.ts";
import type { AcpSession } from "../../src/plugins/acpRuntime/protocol/session.ts";
import { parseChunkText } from "../../src/contracts/acp/content.ts";
import { EchoAgent } from "../helpers/echo-agent.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import type { PermissionOption } from "../../src/plugins/acpRuntime/types.ts";
import { createChrysDialect } from "../../src/plugins/agents/enhancements/icode/chrysDialect.ts";

type SessionOptions = ConstructorParameters<typeof AcpSession>[1];

function makeSession(options: SessionOptions = {}) {
  const { client, peer } = createTransportPair();
  const agent = new EchoAgent();
  agent.attach(peer);
  // 与生产装配（registry.createDialect）一致：echo-agent 讲 chrys 方言，
  // 私有通知/反向请求的解析经方言钩子注入
  const session = createOwnedSession(client, {
    dialect: createChrysDialect(),
    ...options,
  });
  return { session, agent, peer };
}

/** 建好已握手的会话（大多数用例的前置）。 */
async function makeReadySession(options: SessionOptions = {}) {
  const fixture = makeSession(options);
  await fixture.session.initialize();
  await fixture.session.newSession("D:/work");
  return fixture;
}

/** 收集事件直到满足条件或超时（必须在触发动作之前调用）。 */
function collectEvents(
  session: AcpSession,
  until: (events: AcpSessionEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<AcpSessionEvent[]> {
  const events: AcpSessionEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("collectEvents 超时")),
      timeoutMs,
    );
    const unsubscribe = session.onEvent((event) => {
      events.push(event);
      if (until(events)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      }
    });
  });
}

describe("握手与版本协商", () => {
  it("initialize 成功：版本 1，agentInfo 回读", async () => {
    const { session } = makeSession();
    const result = await session.initialize({ timeoutMs: 1_000 });
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo.name).toBe("echo-agent");
    expect(session.isInitialized).toBe(true);
  });

  it("min 协商：服务端支持 1，客户端请求 1 → 1", async () => {
    const { session } = makeSession({
      clientInfo: { name: "t", version: "1" },
    });
    const result = await session.initialize({ timeoutMs: 1_000 });
    expect(result.protocolVersion).toBe(1);
  });

  it("服务端响应更高版本 → 协商失败（客户端只支持 1）", async () => {
    const { client, peer } = createTransportPair();
    peer.onLine((line) => {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === "initialize" && message.id !== undefined) {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 2,
              agentInfo: { name: "future", version: "9" },
              agentCapabilities: {},
            },
          }),
        );
      }
    });
    const session = createOwnedSession(client);
    const error = await session
      .initialize({ timeoutMs: 1_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpHandshakeError);
    expect((error as Error).message).toContain("协商失败");
  });

  it("服务端版本降级为 0 → 协商失败", async () => {
    const { client, peer } = createTransportPair();
    peer.onLine((line) => {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === "initialize" && message.id !== undefined) {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 0,
              agentInfo: { name: "broken" },
              agentCapabilities: {},
            },
          }),
        );
      }
    });
    const session = createOwnedSession(client);
    await expect(session.initialize({ timeoutMs: 1_000 })).rejects.toThrow(
      AcpHandshakeError,
    );
  });

  it("initialize 超时 → AcpTimeoutError", async () => {
    const { client } = createTransportPair(); // 对端不说话
    const session = createOwnedSession(client);
    await expect(session.initialize({ timeoutMs: 50 })).rejects.toBeInstanceOf(
      AcpTimeoutError,
    );
  });
});

describe("会话生命周期", () => {
  it("setModel 无私有通知也更新会话缓存，供切回会话时恢复当前模型", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const session = createOwnedSession(client);
    await session.initialize();
    await session.newSession("D:/work");
    const availableModels = session.models?.availableModels;
    await session.setModel("another-model");
    expect(session.models?.currentModelId).toBe("another-model");
    expect(session.models?.availableModels).toEqual(availableModels);
    expect(
      agent.receivedRequests.find(
        (request) => request.method === "session/set_model",
      )?.params,
    ).toEqual({
      sessionId: session.sessionId,
      modelId: "another-model",
    });
    await session.closeSession();
  });

  it("newSession：sessionId + modes + models；agent 侧先推 runtime_update", async () => {
    const { session, agent } = makeSession();
    await session.initialize();
    const eventsPromise = collectEvents(
      session,
      (list) =>
        list.some((event) => event.type === "agent_runtime") &&
        list.some((event) => event.type === "plan"),
    );
    const result = await session.newSession("D:/work", { timeoutMs: 1_000 });
    const events = await eventsPromise;
    expect(result.sessionId).toBe("echo-1");
    expect(session.sessionId).toBe("echo-1");
    expect(result.models?.currentModelId).toBe("echo-model");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "manual",
      "auto",
      "bypass",
    ]);
    const runtime = events.find((event) => event.type === "agent_runtime");
    expect(runtime).toMatchObject({
      sessionId: "echo-1",
      runtime: { agentProfile: "echo", modelProfileId: "echo-model" },
    });
    const newRequest = agent.receivedRequests.find(
      (r) => r.method === "session/new",
    );
    expect(newRequest?.params.cwd).toBe("D:/work");
    expect(newRequest?.params.mcpServers).toEqual([]);
  });

  it("listSessions / loadSession 走通", async () => {
    const { session } = await makeReadySession();
    const listed = await session.listSessions("D:/work");
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.sessionId).toBe("echo-1");
    expect(listed.sessions[0]?.title).toContain("Echo 会话");
    await expect(
      session.loadSession("echo-1", "D:/work"),
    ).resolves.toMatchObject({
      models: { currentModelId: "echo-model" },
    });
  });

  it("setMode 触发 current_mode_update 事件", async () => {
    const { session } = await makeReadySession();
    const eventsPromise = collectEvents(session, (list) =>
      list.some((event) => event.type === "current_mode_update"),
    );
    await session.setMode("bypass");
    const events = await eventsPromise;
    const modeEvent = events.find(
      (event) => event.type === "current_mode_update",
    );
    expect(modeEvent).toMatchObject({ modeId: "bypass" });
  });

  it("close：agent 收到 session/close，会话句柄复位", async () => {
    const { session, agent } = await makeReadySession();
    await session.closeSession();
    expect(
      agent.receivedRequests.some((r) => r.method === "session/close"),
    ).toBe(true);
    expect(session.sessionId).toBeNull();
  });
});

describe("prompt 轮次与事件派发", () => {
  it("工具已有元数据和 content 透传，供子代理识别使用", async () => {
    const { session, agent } = await makeReadySession();
    const meta = { chrys: { tool_name: "explore_agent" } };
    const content = [
      {
        type: "content",
        content: {
          type: "text",
          text: "Sub-agent Explore Agent: 1 tool call(s), 2 context token(s), 3 total token(s).",
        },
      },
    ];
    agent.script({
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "child-tool",
          title: "Other",
          kind: "other",
          status: "in_progress",
          rawInput: { prompt: "探索" },
          _meta: meta,
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "child-tool",
          status: "completed",
          content,
        },
      ],
    });
    const collected = collectEvents(session, (events) =>
      events.some((event) => event.type === "tool_call_update"),
    );
    try {
      await session.prompt("探索项目");
      const events = await collected;
      expect(events.find((event) => event.type === "tool_call")).toMatchObject({
        _meta: meta,
      });
      expect(
        events.find((event) => event.type === "tool_call_update"),
      ).toMatchObject({ content });
    } finally {
      await session.closeSession();
    }
  });

  it("完整轮次：chunk / thought / tool_call / tool_call_update / plan / usage / chrys 扩展", async () => {
    const { session, agent } = await makeReadySession();
    agent.script({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "开始" },
        },
        { sessionUpdate: "agent_thought_chunk", content: { text: "思考中" } },
        {
          // 夹具对照 skill-eval/tests/test_acp_events.py::_tool_call
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "read_file",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "AGENTS.md" },
        },
        {
          // 夹具对照 skill-eval/tests/test_acp_events.py::_tool_call_update
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [{ content: { text: "1| line one\n2| line two" } }],
          rawOutput: "1| line one\n2| line two",
        },
        {
          sessionUpdate: "plan",
          entries: [
            { content: "读取文件", priority: "medium", status: "completed" },
            { content: "运行测试", priority: "high", status: "in_progress" },
          ],
        },
        { sessionUpdate: "usage_update", size: 128_000, used: 4096 },
        {
          sessionUpdate: "session_info_update",
          title: "测试轮次",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          chrysMethod: "_chrys/usage_update",
          params: {
            sessionId: "echo-1",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        },
        {
          chrysMethod: "_chrys/warning",
          params: { sessionId: "echo-1", code: "W1", message: "小心" },
        },
        {
          // agent 侧命令清单变体 → 类型化 available_commands 事件
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "review", description: "审查" }],
        },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    const wanted: readonly AcpSessionEvent["type"][] = [
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "usage_update",
      "session_info_update",
      "agent_usage",
      "agent_warning",
      "available_commands",
    ];
    const eventsPromise = collectEvents(session, (list) =>
      wanted.every((type) => list.some((event) => event.type === type)),
    );
    const result = await session.prompt("跑一遍测试", { timeoutMs: 3_000 });
    const events = await eventsPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });

    expect(
      events.find((event) => event.type === "agent_message_chunk"),
    ).toMatchObject({ text: "开始" });
    expect(
      events.find((event) => event.type === "agent_thought_chunk"),
    ).toMatchObject({ text: "思考中" });
    expect(
      events.find(
        (event) => event.type === "tool_call" && event.toolCallId === "tc-1",
      ),
    ).toMatchObject({
      title: "read_file",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "AGENTS.md" },
    });
    const toolUpdate = events.find(
      (event) =>
        event.type === "tool_call_update" && event.toolCallId === "tc-1",
    );
    expect(toolUpdate).toMatchObject({ status: "completed" });
    expect(
      toolUpdate !== undefined && "rawOutput" in toolUpdate
        ? toolUpdate.rawOutput
        : null,
    ).toBe("1| line one\n2| line two");
    expect(events.find((event) => event.type === "plan")).toMatchObject({
      entries: [
        { content: "读取文件", status: "completed" },
        { content: "运行测试", status: "in_progress" },
      ],
    });
    expect(events.find((event) => event.type === "usage_update")).toMatchObject(
      {
        contextSize: 128_000,
        contextUsed: 4096,
      },
    );
    expect(
      events.find((event) => event.type === "session_info_update"),
    ).toMatchObject({
      title: "测试轮次",
    });
    expect(events.find((event) => event.type === "agent_usage")).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(
      events.find((event) => event.type === "agent_warning"),
    ).toMatchObject({
      code: "W1",
      message: "小心",
    });
    // available_commands_update：裸 session/update 变体 → 类型化命令清单事件
    expect(
      events.find((event) => event.type === "available_commands"),
    ).toBeDefined();
  });

  it("命名空间通知（session/update:*）与裸风格等价翻译", async () => {
    const { session, peer } = await makeReadySession();
    const collected = collectEvents(
      session,
      (events) =>
        events.filter((event) => event.type === "available_commands").length >=
          2 && events.some((event) => event.type === "usage_update"),
    );
    // OpenCode 风格：method 用命名空间，params 自带 sessionUpdate 字段
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update:available_commands_update",
        params: {
          sessionId: session.sessionId,
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: "Review my current changes",
              input: { hint: "optional instructions" },
            },
          ],
        },
      }),
    );
    // 极端形状：method 用命名空间，params 不带 sessionUpdate（后缀还原）
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update:available_commands_update",
        params: {
          sessionId: session.sessionId,
          availableCommands: [{ name: "plan" }],
        },
      }),
    );
    // 命名空间的 usage_update（OpenCode 实测口径：size / used）
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update:usage_update",
        params: {
          sessionId: session.sessionId,
          sessionUpdate: "usage_update",
          size: 1_000_000,
          used: 23_481,
        },
      }),
    );
    const events = await collected;
    const commandEvents = events.filter(
      (event) => event.type === "available_commands",
    );
    expect(commandEvents[0]?.commands[0]).toMatchObject({
      name: "review",
      description: "Review my current changes",
      inputHint: "optional instructions",
    });
    // 无 sessionUpdate 字段时从 method 后缀还原，同样翻译成功
    expect(commandEvents[1]?.commands[0]).toMatchObject({ name: "plan" });
    expect(events.find((event) => event.type === "usage_update")).toMatchObject(
      { contextSize: 1_000_000, contextUsed: 23_481 },
    );
  });

  it("嵌套 content 形状（skill-eval 夹具）宽容抽取文本", () => {
    expect(
      parseChunkText([{ content: { text: "1| line one\n2| line two" } }]),
    ).toBe("1| line one\n2| line two");
    expect(parseChunkText("裸字符串")).toBe("裸字符串");
    expect(parseChunkText({ type: "text", text: "标准块" })).toBe("标准块");
    expect(parseChunkText([{ text: "a" }, { content: { text: "b" } }])).toBe(
      "ab",
    );
    expect(parseChunkText(null)).toBe("");
  });

  it("取消：挂起轮次收到 cancel 通知后回 stopReason=cancelled", async () => {
    const { session, agent } = await makeReadySession();
    agent.script({ hangUntilCancelled: true });
    const promptPromise = session.prompt("长任务", { timeoutMs: 10_000 });
    // 等一小段时间让轮次真正挂起
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    session.cancel();
    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    expect(
      agent.receivedNotifications.some((n) => n.method === "session/cancel"),
    ).toBe(true);
  });

  it("无脚本轮次：默认 end_turn", async () => {
    const { session } = await makeReadySession();
    const result = await session.prompt("随便聊聊", { timeoutMs: 3_000 });
    expect(result.stopReason).toBe("end_turn");
  });

  it("prompt 响应缺 stopReason → AcpResponseError（形状不合法）", async () => {
    const { client, peer } = createTransportPair();
    peer.onLine((line) => {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.id === undefined || message.method === undefined) {
        return;
      }
      if (message.method === "initialize") {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "broken" },
              agentCapabilities: {},
            },
          }),
        );
        return;
      }
      if (message.method === "session/new") {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { sessionId: "s-broken" },
          }),
        );
        return;
      }
      if (message.method === "session/prompt") {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { nonsense: true },
          }),
        );
      }
    });
    const session = createOwnedSession(client);
    await session.initialize();
    await session.newSession("D:/work");
    await expect(
      session.prompt("hi", { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(AcpResponseError);
  });

  it("未建立会话就 prompt → AcpHandshakeError", async () => {
    const { session } = makeSession();
    await session.initialize();
    await expect(session.prompt("hi")).rejects.toBeInstanceOf(
      AcpHandshakeError,
    );
  });
});

describe("反向请求", () => {
  it("权限请求：注入回调答复 allow；agent 收到决策", async () => {
    const decisions: { title: string; optionCount: number }[] = [];
    const { session, agent } = await makeReadySession({
      onPermissionRequest: (_sessionId, toolCall, options) => {
        decisions.push({
          title: String(toolCall.title),
          optionCount: options.length,
        });
        const allow = options.find((option) => option.optionId === "allow");
        return Promise.resolve(
          allow === undefined
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: allow.optionId },
        );
      },
    });
    agent.script({
      reverseRequest: { kind: "permission" },
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "已继续" },
        },
      ],
    });
    const eventsPromise = collectEvents(session, (list) =>
      list.some((event) => event.type === "agent_message_chunk"),
    );
    const result = await session.prompt("需要权限的操作", { timeoutMs: 3_000 });
    await eventsPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(decisions).toEqual([{ title: "run_command", optionCount: 2 }]);
    const outcome = agent.receivedRequests.find(
      (r) => r.method === "permission-outcome",
    );
    expect(outcome?.params).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("权限请求：未注入回调 → 自动取消 → 协议形状改选中拒绝项", async () => {
    const { session, agent } = await makeReadySession();
    agent.script({
      reverseRequest: { kind: "permission" },
    });
    const result = await session.prompt("危险操作", { timeoutMs: 3_000 });
    expect(result.stopReason).toBe("end_turn");
    const outcome = agent.receivedRequests.find(
      (r) => r.method === "permission-outcome",
    );
    // cancelled 语义等价于选中拒绝项（部分 agent SDK 的响应 union 只认
    // selected 形状，回 cancelled 会在对端解析抛异常）；响应整体为嵌套
    // outcome 对象（RequestPermissionResponse 协议形状）
    expect(outcome?.params).toMatchObject({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("结构化提问：方言钩子注入回调按 label 回答", async () => {
    const { session, agent } = await makeReadySession({
      dialect: createChrysDialect({
        onQuestion: (_sessionId, requestId, questions) => {
          expect(requestId).toMatch(/^ask-/);
          const first = questions[0];
          expect(first?.question).toContain("分支");
          expect(first?.header).toBe("分支");
          expect(first?.multiSelect).toBe(false);
          return Promise.resolve({
            answers: [{ values: [first?.options[0]?.label ?? ""], note: "" }],
          });
        },
      }),
    });
    agent.script({
      reverseRequest: { kind: "question" },
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "好的" },
        },
      ],
    });
    const result = await session.prompt("选分支", { timeoutMs: 3_000 });
    expect(result.stopReason).toBe("end_turn");
    const outcome = agent.receivedRequests.find(
      (r) => r.method === "request-input-outcome",
    );
    expect(outcome?.params).toMatchObject({
      answers: [{ values: ["main"], note: "" }],
    });
  });

  it("结构化提问：未注入回调 → cancelled", async () => {
    const { session, agent } = await makeReadySession();
    agent.script({ reverseRequest: { kind: "question" } });
    const result = await session.prompt("选分支", { timeoutMs: 3_000 });
    expect(result.stopReason).toBe("end_turn");
    const outcome = agent.receivedRequests.find(
      (r) => r.method === "request-input-outcome",
    );
    expect(outcome?.params).toMatchObject({ cancelled: true });
  });

  it("权限选项 kind 表外/缺失 → unknown（安全默认，绝不回落 allow）", async () => {
    const { client, peer } = createTransportPair();
    let seenOptions: readonly PermissionOption[] | null = null;
    const session = createOwnedSession(client, {
      onPermissionRequest: (_sessionId, _toolCall, options) => {
        seenOptions = options;
        return Promise.resolve({ outcome: "cancelled" });
      },
    });
    // 手工对端：应答 initialize / session/new
    peer.onLine((line) => {
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
      };
      if (typeof message.method !== "string" || message.id === undefined) {
        return;
      }
      if (message.method === "initialize") {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "manual" },
              agentCapabilities: {},
            },
          }),
        );
        return;
      }
      peer.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: "s-x" },
        }),
      );
    });
    await session.initialize();
    await session.newSession("D:/work");
    // 反向请求：一个 kind 为表外值、一个 kind 缺失
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "p1",
        method: "session/request_permission",
        params: {
          sessionId: "s-x",
          toolCall: { toolCallId: "t1" },
          options: [
            { optionId: "odd", name: "Mystery", kind: "ask_every_time" },
            { optionId: "blank", name: "NoKind" },
          ],
        },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(seenOptions).toEqual([
      { optionId: "odd", name: "Mystery", kind: "unknown" },
      { optionId: "blank", name: "NoKind", kind: "unknown" },
    ]);
  });
});

describe("方言扩展点", () => {
  /** 手工对端：应答 initialize / session/new（最简握手）。 */
  function respondHandshake(
    peer: ReturnType<typeof createTransportPair>["peer"],
  ): void {
    peer.onLine((line) => {
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
      };
      if (typeof message.method !== "string" || message.id === undefined) {
        return;
      }
      if (message.method === "initialize") {
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "manual" },
              agentCapabilities: {},
            },
          }),
        );
        return;
      }
      peer.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: "s-x" },
        }),
      );
    });
  }

  it("未注入方言：chrys 私有通知按 unknown_notification 兜底（协议层不认识 chrys）", async () => {
    const { client, peer } = createTransportPair();
    respondHandshake(peer);
    const session = createOwnedSession(client);
    await session.initialize();
    await session.newSession("D:/work");
    const eventsPromise = collectEvents(session, (list) =>
      list.some(
        (event) =>
          event.type === "unknown_notification" &&
          event.method === "_chrys/warning",
      ),
    );
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_chrys/warning",
        params: { sessionId: "s-x", code: "W1", message: "m" },
      }),
    );
    const events = await eventsPromise;
    const fallback = events.find(
      (event) => event.type === "unknown_notification",
    );
    expect(fallback).toMatchObject({
      method: "_chrys/warning",
      params: { code: "W1", message: "m" },
    });
  });

  it("注入方言：私有通知翻译为类型化事件（协议层分派顺序：方言先行）", async () => {
    const { client, peer } = createTransportPair();
    respondHandshake(peer);
    const session = createOwnedSession(client, {
      dialect: createChrysDialect(),
    });
    await session.initialize();
    await session.newSession("D:/work");
    const eventsPromise = collectEvents(session, (list) =>
      list.some((event) => event.type === "agent_warning"),
    );
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_chrys/warning",
        params: { sessionId: "s-x", code: "W1", message: "小心" },
      }),
    );
    const events = await eventsPromise;
    expect(
      events.find((event) => event.type === "agent_warning"),
    ).toMatchObject({ code: "W1", message: "小心" });
  });
});

it("standard ACP cancellation is not rewritten to an ICode reject option", async () => {
  const { session, agent } = await makeReadySession({ dialect: undefined });
  agent.script({ reverseRequest: { kind: "permission" } });
  await session.prompt("test", { timeoutMs: 3000 });
  expect(
    agent.receivedRequests.find((r) => r.method === "permission-outcome")
      ?.params,
  ).toEqual({ outcome: { outcome: "cancelled" } });
  await sessionConnection(session).kill();
});
