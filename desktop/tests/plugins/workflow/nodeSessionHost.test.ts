/**
 * 工作流节点会话宿主（ADR 037）：节点会话是应用的普通会话，宿主只经会话能力
 * 打开会话、发任务说明、订阅轮次；不自己持有连接，也不转发用户消息。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AcpSessionEvent } from "../../../src/plugins/acpRuntime/events.ts";
import type { PluginSessionOptions, SessionTarget, SessionTurnEvent } from "../../../src/plugins/project/service.ts";
import type { MessageDisplay } from "../../../src/shared/messageDisplay.ts";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import { attachNodeSessionHost, type NodeSessionPort } from "../../../src/plugins/workflow/sessionHost/nodeSessionHost.ts";

const offer = {
  name: "aaw-workflow-result",
  stdio: { command: "C:/aaw/workflow_service.exe", args: ["--result-mcp", "127.0.0.1:50123"], env: [{ name: "AAW_RESULT_TOKEN", value: "secret" }] },
  http: { url: "http://127.0.0.1:50123/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] },
};
const stdioElement = { name: "aaw-workflow-result", command: "C:/aaw/workflow_service.exe", args: ["--result-mcp", "127.0.0.1:50123"], env: [{ name: "AAW_RESULT_TOKEN", value: "secret" }] };
const httpElement = { type: "http", name: "aaw-workflow-result", url: "http://127.0.0.1:50123/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] };

const action = (site = "ask#1", ordinal = 1, input: unknown = { __node: { actor: "需求确认" } }) => ({ site, ordinal, actor: "ask#1", input });
const requirement = (overrides: Record<string, unknown> = {}) => ({
  action: action(), cwd: "D:/project", command: ["agent"], profile: null, mcp_servers: [], result_channel: offer, resume_session_id: null, ...overrides,
});

/** 模拟应用的会话能力：可以手动开始、结束一轮。 */
function fakeSessions() {
  const turnWatchers = new Set<(event: SessionTurnEvent) => void>();
  const eventWatchers = new Set<(event: AcpSessionEvent) => void>();
  const opened: PluginSessionOptions[] = [];
  const sent: { text: string; display: MessageDisplay }[] = [];
  const cancelled: SessionTarget[] = [];
  let running = false;
  const start = () => {
    running = true;
    for (const watcher of [...turnWatchers]) watcher({ type: "started" });
  };
  const end = (outcome: "completed" | "cancelled" | "failed" = "completed", error: string | null = null) => {
    running = false;
    for (const watcher of [...turnWatchers]) watcher({ type: "ended", outcome, stopReason: outcome === "cancelled" ? "cancelled" : "end_turn", error });
  };
  const port: NodeSessionPort = {
    open: (options) => {
      opened.push(options);
      return Promise.resolve({ workspacePath: options.workspacePath, agentKey: "key", sessionId: options.resumeSessionId ?? "s-1" });
    },
    send: (_target, message) => {
      if (running) return false;
      sent.push(message);
      start();
      return true;
    },
    cancel: (target) => {
      cancelled.push(target);
      end("cancelled");
    },
    isRunning: () => running,
    watchTurns: (_target, listener) => {
      turnWatchers.add(listener);
      return () => turnWatchers.delete(listener);
    },
    watchEvents: (_target, listener) => {
      eventWatchers.add(listener);
      return () => eventWatchers.delete(listener);
    },
  };
  return { port, opened, sent, cancelled, start, end, emitEvent: (event: AcpSessionEvent) => eventWatchers.forEach((w) => w(event)) };
}

function harness() {
  const sessions = fakeSessions();
  const observers = new Set<(event: WorkflowEvent) => void>();
  const responses: { id: number; response: Record<string, unknown> }[] = [];
  const projected: WorkflowEvent[] = [];
  const detach = attachNodeSessionHost({
    workflow: {
      subscribe: (listener) => {
        observers.add(listener);
        return () => observers.delete(listener);
      },
      respondHostFrame: (_runId, frame) => {
        responses.push(JSON.parse(frame) as { id: number; response: Record<string, unknown> });
        return Promise.resolve();
      },
    },
    sessions: sessions.port,
    onEvent: (event) => projected.push(event),
  });
  let serial = 0;
  const send = (request: Record<string, unknown>) => {
    const id = ++serial;
    for (const observer of observers) observer({ type: "host-frame", runId: "run-1", frame: JSON.stringify({ id, request }) });
    return id;
  };
  const responseOf = async (id: number) => {
    await vi_waitFor(() => responses.some((item) => item.id === id));
    return responses.find((item) => item.id === id)!.response;
  };
  return { ...sessions, responses, projected, detach, send, responseOf };
}

async function vi_waitFor(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

let current: ReturnType<typeof harness> | null = null;
afterEach(() => {
  current?.detach();
  current = null;
});

describe("打开节点会话", () => {
  it("打开普通会话：标题是角色名，带上调用方工具和交结果工具（按 Agent 能力选 stdio / HTTP）", async () => {
    const h = (current = harness());
    const caller = { name: "local", command: "tool.exe", args: [], env: [] };
    const id = h.send({ kind: "spawn_node_session", requirement: requirement({ mcp_servers: [caller, { bogus: true }], model: "fast" }) });
    expect(await h.responseOf(id)).toEqual({ result: { sessionId: "s-1" } });
    const options = h.opened[0]!;
    expect(options).toMatchObject({ workspacePath: "D:/project", title: "需求确认", model: "fast" });
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.tools!(null)).toEqual([caller, stdioElement]);
    expect(options.tools!({ agentCapabilities: { mcpCapabilities: { http: true } } } as never)).toEqual([caller, httpElement]);
    expect(h.projected[0]).toMatchObject({ type: "acp-session-created", runId: "run-1", sessionId: "s-1", persona: "需求确认" });
  });

  it("恢复会话按原 id 打开；结果通道提供不全时如实失败、不打开会话", async () => {
    const h = (current = harness());
    const resumed = h.send({ kind: "spawn_node_session", requirement: requirement({ resume_session_id: "s-9" }) });
    expect(await h.responseOf(resumed)).toEqual({ result: { sessionId: "s-9" } });
    expect(h.opened[0]?.resumeSessionId).toBe("s-9");
    const invalid = h.send({ kind: "spawn_node_session", requirement: requirement({ result_channel: { name: "x" } }) });
    expect(await h.responseOf(invalid)).toEqual({ code: "RESULT_CHANNEL_OFFER_INVALID" });
    expect(h.opened).toHaveLength(1);
  });
});

describe("一轮工作流轮次", () => {
  it("任务说明作为插件消息发出（收成一行），这一轮结束才应答；运行第一步把用户的要求显示出来", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const first = action("ask#1", 1, { __initial: true, vars: { input: { requirement: "做一个登录页" } }, __node: { actor: "需求确认" } });
    const id = h.send({ kind: "prompt_turn", session_id: "s-1", action: first, prompt: "确认需求" });
    await vi_waitFor(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({ text: "做一个登录页\n\n确认需求", display: { source: "workflow", visible: "做一个登录页", foldLabel: "工作流给 Agent 的说明" } });
    expect(h.responses.some((item) => item.id === id)).toBe(false);
    h.end();
    expect(await h.responseOf(id)).toEqual({ result: null });
  });

  it("运行没填输入时第一步不显示「{}」，整段说明收起", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const first = action("ask#1", 1, { __initial: true, vars: { input: {} }, __node: { actor: "写入" } });
    h.send({ kind: "prompt_turn", session_id: "s-1", action: first, prompt: "写文件" });
    await vi_waitFor(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({ text: "写文件", display: { source: "workflow", visible: "", foldLabel: "工作流给 Agent 的说明" } });
    h.end();
  });

  it("被用户打断不算失败；出错才报给引擎", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const cancelled = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "做事" });
    await vi_waitFor(() => h.sent.length === 1);
    h.end("cancelled");
    expect(await h.responseOf(cancelled)).toEqual({ result: null });
    const failed = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "再做" });
    await vi_waitFor(() => h.sent.length === 2);
    h.end("failed", "连接断开");
    expect(await h.responseOf(failed)).toEqual({ code: "连接断开" });
  });

  it("用户正在和 Agent 聊时，等这一轮结束再发任务说明", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    h.start();
    const id = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "做事" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toHaveLength(0);
    h.end();
    await vi_waitFor(() => h.sent.length === 1);
    h.end();
    expect(await h.responseOf(id)).toEqual({ result: null });
  });

  it("会话事件归到当前这一步，交给运行视图", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    h.send({ kind: "prompt_turn", session_id: "s-1", action: action("repair", 2), prompt: "修" });
    await vi_waitFor(() => h.sent.length === 1);
    h.emitEvent({ type: "agent_message_chunk", sessionId: "s-1", text: "在改" });
    const message = h.projected.find((event) => event.type === "acp-event" && (event.event as { type?: string }).type === "agent_message_chunk");
    expect(message).toMatchObject({ runId: "run-1", instance: { siteId: "repair", ordinal: 2 } });
  });
});

describe("等下一轮结束", () => {
  it("用户在会话里回复的那一轮结束时应答；等待之前已经结束的一轮立即算数", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const turn = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "做事" });
    await vi_waitFor(() => h.sent.length === 1);
    h.end();
    await h.responseOf(turn);
    const wait = h.send({ kind: "wait_turn_ended", session_id: "s-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.responses.some((item) => item.id === wait)).toBe(false);
    // 用户自己发消息：普通会话的一轮，宿主不经手，只看它结束。
    h.start();
    h.end();
    expect(await h.responseOf(wait)).toEqual({ result: null });
    // 引擎还没来等，用户已经又聊完一轮：等的时候立即应答。
    h.start();
    h.end();
    const late = h.send({ kind: "wait_turn_ended", session_id: "s-1" });
    expect(await h.responseOf(late)).toEqual({ result: null });
  });
});

describe("运行停止", () => {
  it("唤醒挂起的等待、停下进行中的一轮；本帧不应答，会话留给用户继续用", async () => {
    const h = (current = harness());
    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const wait = h.send({ kind: "wait_turn_ended", session_id: "s-1" });
    const stop = h.send({ kind: "cancel_waiting" });
    expect(await h.responseOf(wait)).toEqual({ code: "RUN_CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.responses.some((item) => item.id === stop)).toBe(false);
    // 停止后这个会话不再归这次运行：引擎再问就如实说不在。
    const after = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "做事" });
    expect(await h.responseOf(after)).toEqual({ code: "WORKFLOW_SESSION_NOT_HOSTED" });

    await h.responseOf(h.send({ kind: "spawn_node_session", requirement: requirement() }));
    const running = h.send({ kind: "prompt_turn", session_id: "s-1", action: action(), prompt: "做事" });
    await vi_waitFor(() => h.sent.length === 1);
    h.send({ kind: "cancel_waiting" });
    await vi_waitFor(() => h.cancelled.length === 1);
    expect(await h.responseOf(running)).toEqual({ result: null });
  });
});
