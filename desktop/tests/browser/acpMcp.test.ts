import { describe, expect, it, vi } from "vitest";
import { createOwnedSession } from "../helpers/ownedSession.ts";
import { EchoAgent } from "../helpers/echo-agent.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { createChrysDialect } from "../../src/plugins/agents/enhancements/icode/chrysDialect.ts";

describe("TD-04-I01 ACP MCP 注册", () => {
  it("session/new 携带每会话 HTTP MCP，并在真实 ID 返回后绑定", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const onSessionReady = vi.fn();
    const endpoint = {
      type: "http" as const,
      name: "aaw-browser-test",
      url: "http://127.0.0.1:41001/mcp",
      headers: [{ name: "Authorization", value: "Bearer test-token" }],
    };
    const session = createOwnedSession(client, {
      mcpServers: [endpoint],
      onSessionReady,
    });
    await session.initialize();
    const created = await session.newSession("D:/work");
    const request = agent.receivedRequests.find(
      (entry) => entry.method === "session/new",
    );
    expect(request?.params.mcpServers).toEqual([endpoint]);
    expect(onSessionReady).toHaveBeenCalledWith(created.sessionId);
  });
});

describe("TD-04-I05 ACP 会话资源释放", () => {
  it("关闭会话撤销端点且只执行一次", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const onSessionDisposed = vi.fn();
    const session = createOwnedSession(client, { onSessionDisposed });
    await session.initialize();
    await session.newSession("D:/work");
    await session.closeSession();
    await session.closeSession();
    expect(onSessionDisposed).toHaveBeenCalledTimes(1);
  });

  it("连接失效撤销端点，不等待下一轮工具调用", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const onSessionDisposed = vi.fn();
    const session = createOwnedSession(client, { onSessionDisposed });
    await session.initialize();
    await session.newSession("D:/work");
    session.invalidateConnection();
    await vi.waitFor(() => expect(onSessionDisposed).toHaveBeenCalledTimes(1));
  });
});

describe("TD-04-I03 轮次浏览器取消", () => {
  it("主动取消与轮次结束分别通知当前会话", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const onCancel = vi.fn();
    const onPromptSettled = vi.fn();
    const session = createOwnedSession(client, { onCancel, onPromptSettled });
    await session.initialize();
    const created = await session.newSession("D:/work");
    session.cancel();
    expect(onCancel).toHaveBeenCalledWith(created.sessionId);
    await session.prompt("完成一轮");
    await vi.waitFor(() =>
      expect(onPromptSettled).toHaveBeenCalledWith(created.sessionId),
    );
    expect(onPromptSettled).toHaveBeenCalledTimes(1);
  });
});

describe("TD-024-A01 新轮次浏览器生命周期", () => {
  it("在真实 session/prompt 前通知开始，并在终态通知结束", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const calls: string[] = [];
    let promptExistedAtStart: boolean | null = null;
    const onPromptStart = vi.fn((sessionId: string) => {
      promptExistedAtStart = agent.receivedRequests.some(
        (entry) => entry.method === "session/prompt",
      );
      calls.push(`start:${sessionId}`);
    });
    const onPromptSettled = vi.fn((sessionId: string) => {
      calls.push(`settled:${sessionId}`);
    });
    const session = createOwnedSession(client, {
      onPromptStart,
      onPromptSettled,
    });
    await session.initialize();
    const created = await session.newSession("D:/work");
    await session.prompt("开始新轮次");
    const prompt = agent.receivedRequests.find(
      (entry) => entry.method === "session/prompt",
    );
    expect(onPromptStart).toHaveBeenCalledExactlyOnceWith(created.sessionId);
    expect(onPromptSettled).toHaveBeenCalledExactlyOnceWith(created.sessionId);
    expect(prompt?.params.sessionId).toBe(created.sessionId);
    expect(promptExistedAtStart).toBe(false);
    expect(calls).toEqual([
      `start:${created.sessionId}`,
      `settled:${created.sessionId}`,
    ]);
  });
});

describe("TD-08-B08 当前页面上下文", () => {
  it("用户正文保持不变，ACP 提示附加上下文块", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const session = createOwnedSession(client, {
      onPromptContext: () =>
        Promise.resolve([
          { type: "text", text: "当前页面：https://local.test" },
        ]),
    });
    await session.initialize();
    await session.newSession("D:/work");
    await session.prompt("检查这个页面");
    const request = agent.receivedRequests.find(
      (entry) => entry.method === "session/prompt",
    );
    expect(request?.params.prompt).toEqual([
      { type: "text", text: "检查这个页面" },
      { type: "text", text: "当前页面：https://local.test" },
    ]);
  });
});

describe("TD-04-I02 同会话主子不再建立身份登记", () => {
  it("iCode 子 Agent 通知不生成浏览器参与者生命周期事件", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const onParticipantEvent = vi.fn();
    const events: { type?: string; status?: string }[] = [];
    const session = createOwnedSession(client, {
      dialect: createChrysDialect(),
      onParticipantEvent,
    });
    session.onEvent((event) => events.push(event));
    await session.initialize();
    const created = await session.newSession("D:/work");
    for (const notification of [
      {
        method: "_chrys/sub_agent_invocation_start",
        params: {
          sessionId: created.sessionId,
          invocationId: "invocation-a",
          parentCallId: "parent-a",
        },
      },
      {
        method: "_chrys/sub_agent_aborted",
        params: { sessionId: created.sessionId, invocationId: "invocation-a" },
      },
      {
        method: "session/update",
        params: {
          sessionId: created.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "parent-a",
            status: "completed",
          },
        },
      },
    ]) {
      peer.writeLine(JSON.stringify({ jsonrpc: "2.0", ...notification }));
    }
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "tool_call_update" && event.status === "completed",
        ),
      ).toBe(true),
    );
    expect(onParticipantEvent).not.toHaveBeenCalled();
  });
});
