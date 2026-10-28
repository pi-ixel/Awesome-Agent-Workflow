/**
 * 会话 store（src/stores/sessionStore.ts）：
 * - 事件折叠：chunk 增量拼接 / 异类封口 / 工具调用合并 / 系统提示；
 * - 摘要：工具输入优先级、结果截断（对齐 wire.py 口径）；
 * - 轮次生命周期：sendPrompt / requestCancel / 失败路径，以及
 *   beginTurn / endTurn 公开归约入口（回放脚本走它们）；
 * - 端到端：AcpSession + inMemoryTransport + EchoAgent → attachSession。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcpSession, type AcpSessionEvent } from "../../src/acp/session.ts";
import { EchoAgent } from "../../src/acp/mock/echo-agent.ts";
import { createTransportPair } from "../../src/acp/transport/inMemoryTransport.ts";
import {
  attachSession,
  sessionTitleOf,
  toolInputSummary,
  toolResultSummary,
  useSessionStore,
  type SessionBinding,
  type SessionItem,
  type SystemNoticeItem,
} from "../../src/stores/sessionStore.ts";
import { replaySampleConversation } from "../fixtures/sessionScript.ts";

function resetStore(): void {
  const state = useSessionStore.getState();
  // 先停快照目标（会收口落盘并取消节流定时器），再清空条目
  state.setSessionLogTarget(null);
  state.clear();
  state.bindSession(null);
  state.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    modelLabel: null,
    approvalMode: null,
  });
}

function feed(events: readonly AcpSessionEvent[]): void {
  for (const event of events) {
    useSessionStore.getState().handleEvent(event);
  }
}

const chunk = (text: string): AcpSessionEvent => ({
  type: "agent_message_chunk",
  sessionId: "s1",
  text,
});

const thought = (text: string): AcpSessionEvent => ({
  type: "agent_thought_chunk",
  sessionId: "s1",
  text,
});

beforeEach(() => {
  resetStore();
});

describe("事件折叠：消息与思考", () => {
  it("封口与回放提问保留已完成历史条目引用，同时提交缓冲并补齐思考结束时间", () => {
    const closedAssistant: SessionItem = {
      kind: "assistant",
      id: "closed-answer",
      text: "已完成",
      isStreaming: false,
      createdAt: "",
    };
    const closedThought: SessionItem = {
      kind: "thought",
      id: "closed-thought",
      text: "已结束",
      isStreaming: false,
      startedAt: 1,
      endedAt: 2,
    };
    const missingEnd: SessionItem = {
      kind: "thought",
      id: "missing-end",
      text: "补结束时间",
      isStreaming: false,
      startedAt: 1,
      endedAt: null,
    };
    useSessionStore.setState({
      items: [closedAssistant, closedThought, missingEnd],
    });
    feed([chunk("首段"), chunk("缓冲段")]);
    let items = useSessionStore.getState().items;
    expect(items[0]).toBe(closedAssistant);
    expect(items[1]).toBe(closedThought);
    expect(items[2]).toMatchObject({ isStreaming: false });
    const repairedThought = items[2];
    expect(repairedThought?.kind).toBe("thought");
    if (repairedThought?.kind !== "thought") throw new Error("缺少思考条目");
    expect(typeof repairedThought.endedAt).toBe("number");
    expect(items[2]).not.toBe(missingEnd);
    const sealedThought = items[2];
    useSessionStore.getState().sealStreamingItems();
    items = useSessionStore.getState().items;
    expect(items[0]).toBe(closedAssistant);
    expect(items[1]).toBe(closedThought);
    expect(items[2]).toBe(sealedThought);
    expect(items[3]).toMatchObject({ text: "首段缓冲段", isStreaming: false });
    const sealedAnswer = items[3];
    useSessionStore.getState().setHistoryReplaySession("s1");
    feed([{ type: "user_message_chunk", sessionId: "s1", text: "历史提问" }]);
    items = useSessionStore.getState().items;
    expect(items[0]).toBe(closedAssistant);
    expect(items[1]).toBe(closedThought);
    expect(items[2]).toBe(sealedThought);
    expect(items[3]).toBe(sealedAnswer);
    expect(items[4]).toMatchObject({ kind: "user", text: "历史提问" });
    useSessionStore.getState().setHistoryReplaySession(null);
  });
  it("sealStreamingItems：结构化提问打断时流式消息落定（生成中…不再空挂）", () => {
    feed([chunk("请核对："), chunk("上面回显的原文是否一致？")]);
    const before = useSessionStore.getState().items;
    expect(before[0]).toMatchObject({ kind: "assistant", isStreaming: true });

    // agent 抛出 request_input：轮次 Promise 悬着，但生成已停——封口
    useSessionStore.getState().sealStreamingItems();
    const after = useSessionStore.getState().items;
    expect(after[0]).toMatchObject({
      kind: "assistant",
      text: "请核对：上面回显的原文是否一致？",
      isStreaming: false,
    });
  });

  it("多个 agent_message_chunk 拼接为一条流式消息（120ms 窗口内合并提交）", () => {
    feed([chunk("第一段，"), chunk("第二段"), chunk("第三段")]);
    // 时间片合并：首分片即时建条目，后续在缓冲里，flush 后才拼齐
    useSessionStore.getState().flushStreamingChunks();
    const items = useSessionStore.getState().items;
    expect(items).toHaveLength(1);
    const message = items[0];
    expect(message).toMatchObject({
      kind: "assistant",
      text: "第一段，第二段第三段",
      isStreaming: true,
    });
  });

  it("工具调用出现即封口流式消息，后续 chunk 落新条目", () => {
    feed([
      chunk("先看文件。"),
      {
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "t1",
        title: "read a.ts",
        status: "in_progress",
      },
      chunk("看完了。"),
    ]);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(items[0]).toMatchObject({ isStreaming: false });
    expect(items[2]).toMatchObject({ isStreaming: true });
  });

  it("思考与消息互斥：消息 chunk 到来时封口思考条目", () => {
    feed([thought("推理中…"), chunk("结论如下")]);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual(["thought", "assistant"]);
    expect(items[0]).toMatchObject({ isStreaming: false });
  });
});

describe("历史回放：用户提问", () => {
  it("回放只接纳目标会话，缺少 messageId 的相邻通知分别生成消息，并封口助手回复", () => {
    const store = useSessionStore.getState();
    store.setHistoryReplaySession("s1");
    feed([
      chunk("之前的回复"),
      { type: "user_message_chunk", sessionId: "s2", text: "其他会话" },
      { type: "user_message_chunk", sessionId: "s1", text: "第一个问题" },
      { type: "user_message_chunk", sessionId: "s1", text: "第二个问题" },
      chunk("后一轮回复"),
    ]);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual([
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
    expect(items[0]).toMatchObject({ text: "之前的回复", isStreaming: false });
    expect(items[1]).toMatchObject({ text: "第一个问题", createdAt: "" });
    expect(items[2]).toMatchObject({ text: "第二个问题", createdAt: "" });
    expect(items[3]).toMatchObject({ text: "后一轮回复" });
  });

  it("只拼接同一 messageId 的连续分片；异类事件或目标切换会封口", () => {
    const store = useSessionStore.getState();
    store.setHistoryReplaySession("s1");
    feed([
      {
        type: "user_message_chunk",
        sessionId: "s1",
        messageId: "m1",
        text: "相同",
      },
      {
        type: "user_message_chunk",
        sessionId: "s1",
        messageId: "m1",
        text: "消息",
      },
      {
        type: "usage_update",
        sessionId: "s1",
        contextSize: null,
        contextUsed: null,
      },
      {
        type: "user_message_chunk",
        sessionId: "s1",
        messageId: "m1",
        text: "新的消息",
      },
      {
        type: "user_message_chunk",
        sessionId: "s1",
        messageId: "m2",
        text: "另一个消息",
      },
    ]);
    expect(
      useSessionStore
        .getState()
        .items.map((item) => (item.kind === "user" ? item.text : "")),
    ).toEqual(["相同消息", "新的消息", "另一个消息"]);
    store.setHistoryReplaySession(null);
    feed([
      {
        type: "user_message_chunk",
        sessionId: "s1",
        messageId: "m2",
        text: "实时回显",
      },
    ]);
    expect(useSessionStore.getState().items).toHaveLength(3);
    store.setHistoryReplaySession("s2");
    feed([
      { type: "user_message_chunk", sessionId: "s1", text: "旧会话" },
      { type: "user_message_chunk", sessionId: "s2", text: "新会话" },
    ]);
    expect(useSessionStore.getState().items.at(-1)).toMatchObject({
      kind: "user",
      text: "新会话",
    });
  });

  it("清空或恢复快照会结束回放；正常发送的实时回显仍不双写", () => {
    const store = useSessionStore.getState();
    store.setHistoryReplaySession("s1");
    store.clear();
    feed([{ type: "user_message_chunk", sessionId: "s1", text: "迟到的回放" }]);
    expect(useSessionStore.getState().items).toHaveLength(0);
    store.setHistoryReplaySession("s1");
    store.restoreItems([]);
    feed([{ type: "user_message_chunk", sessionId: "s1", text: "迟到的回放" }]);
    expect(useSessionStore.getState().items).toHaveLength(0);
    store.beginTurn("手动发送");
    feed([{ type: "user_message_chunk", sessionId: "s1", text: "手动发送" }]);
    expect(useSessionStore.getState().items).toHaveLength(1);
    expect(useSessionStore.getState().items[0]).toMatchObject({
      kind: "user",
      text: "手动发送",
    });
  });
});

describe("事件折叠：工具调用合并", () => {
  it("tool_call_update 按 toolCallId 合并，title 沿用落笔值", () => {
    feed([
      {
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "t1",
        title: "run npm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
      },
      {
        type: "tool_call_update",
        sessionId: "s1",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "3 passed",
      },
    ]);
    const items = useSessionStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      title: "run npm test",
      toolKind: "execute",
      status: "completed",
      rawOutput: "3 passed",
      resultSummary: "3 passed",
    });
  });

  it("update 先于 tool_call 到达也能落卡（title 回落 toolCallId）", () => {
    feed([
      {
        type: "tool_call_update",
        sessionId: "s1",
        toolCallId: "t9",
        status: "failed",
        rawOutput: "boom",
      },
    ]);
    const items = useSessionStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      title: "t9",
      status: "failed",
    });
  });
});

describe("事件折叠：元信息与系统提示", () => {
  it("current_mode_update 更新审批模式为中文名", () => {
    feed([{ type: "current_mode_update", sessionId: "s1", modeId: "bypass" }]);
    expect(useSessionStore.getState().approvalMode).toEqual({
      id: "bypass",
      name: "全部放行",
    });
  });

  it("chrys_runtime 的 modelProfileId 更新模型显示", () => {
    feed([
      {
        type: "chrys_runtime",
        sessionId: "s1",
        runtime: { modelProfileId: "glm-4.7-coding" },
      },
    ]);
    expect(useSessionStore.getState().modelLabel).toBe("glm-4.7-coding");
  });

  it("chrys_error / chrys_warning 落为系统提示", () => {
    feed([
      {
        type: "chrys_error",
        sessionId: "s1",
        code: "E1",
        message: "坏了",
        recoverable: true,
      },
      { type: "chrys_warning", sessionId: "s1", code: null, message: "小心" },
    ]);
    const systems = useSessionStore
      .getState()
      .items.filter((item): item is SystemNoticeItem => item.kind === "system");
    expect(systems.map((item) => `${item.kind}:${item.level}`)).toEqual([
      "system:error",
      "system:warn",
    ]);
    expect(systems[0]?.text).toContain("E1");
    expect(systems[0]?.text).toContain("坏了");
  });

  it("user_message_chunk 被忽略（chrys 不回显，避免双写）", () => {
    feed([{ type: "user_message_chunk", sessionId: "s1", text: "hi" }]);
    expect(useSessionStore.getState().items).toHaveLength(0);
  });
});

describe("摘要函数（对照 wire.py）", () => {
  it("优先取 skill_name / command，最多两个字段", () => {
    const summary = toolInputSummary(
      {
        skill_name: "code-review",
        command: "aaw review",
        path: "x",
        query: "y",
      },
      "工具",
    );
    expect(summary).toBe("skill_name=code-review · command=aaw review");
  });

  it("跳过与标题重复的值（chrys 用 command 当标题）", () => {
    expect(
      toolInputSummary({ command: "npm test", path: "desktop" }, "npm test"),
    ).toBe("path=desktop");
  });

  it("字符串输入折叠空白并截断 120 字符", () => {
    const long = "a".repeat(200);
    expect(toolInputSummary(`  hello   world  ${long}  `, "t")).toHaveLength(
      120,
    );
    expect(toolInputSummary("hello world", "t")).toBe("hello world");
    // 与标题相同的字符串输入返回空
    expect(toolInputSummary("same", "same")).toBe("");
  });

  it("非对象非字符串的输入不猜形状", () => {
    expect(toolInputSummary(42, "t")).toBe("");
    expect(toolInputSummary([1, 2], "t")).toBe("");
    expect(toolInputSummary(null, "t")).toBe("");
  });

  it("对象值序列化为 JSON 后计入摘要", () => {
    expect(toolInputSummary({ options: { deep: true } }, "t")).toBe(
      'options={"deep":true}',
    );
  });

  it("结果摘要折叠空白并截断 200 字符", () => {
    expect(toolResultSummary("  a\nb  c  ")).toBe("a b c");
    expect(toolResultSummary("x".repeat(300))).toHaveLength(200);
    expect(toolResultSummary({ lines: ["l1", "l2"] })).toBe(
      '{"lines":["l1","l2"]}',
    );
    expect(toolResultSummary(undefined)).toBe("");
  });
});

describe("轮次生命周期（经绑定驱动）", () => {
  function bindWith(
    promptImpl: (
      text: string,
    ) => Promise<{ stopReason: "end_turn" | "cancelled" }>,
  ): { prompt: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
    const prompt = vi.fn(promptImpl);
    const cancel = vi.fn();
    const binding: SessionBinding = { prompt, cancel };
    useSessionStore.getState().bindSession(binding);
    return { prompt, cancel };
  }

  it("sendPrompt 落笔用户消息，响应到达后按 stopReason 收尾", async () => {
    const { prompt } = bindWith((text) => {
      feed([chunk(`回声：${text}`)]);
      return Promise.resolve({ stopReason: "end_turn" });
    });
    useSessionStore.getState().sendPrompt("你好");
    const state = useSessionStore.getState();
    expect(state.isAgentRunning).toBe(true);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "你好" });
    await vi.waitFor(() => {
      expect(useSessionStore.getState().isAgentRunning).toBe(false);
    });
    expect(prompt).toHaveBeenCalledWith("你好");
    expect(useSessionStore.getState().lastStopReason).toBe("end_turn");
    // end_turn 不额外加系统提示
    expect(
      useSessionStore.getState().items.filter((item) => item.kind === "system"),
    ).toHaveLength(0);
  });

  it("cancelled 收尾追加「本轮已取消」系统提示", async () => {
    bindWith(() => Promise.resolve({ stopReason: "cancelled" }));
    useSessionStore.getState().sendPrompt("停下");
    await vi.waitFor(() => {
      expect(useSessionStore.getState().isAgentRunning).toBe(false);
    });
    const systems = useSessionStore
      .getState()
      .items.filter((item) => item.kind === "system");
    expect(systems).toHaveLength(2);
    expect(systems[0]).toMatchObject({ level: "warn", text: "本轮已取消" });
    // 结案卡：本轮无写类操作时的零操作交代
    expect(systems[1]).toMatchObject({
      level: "warn",
      text: "本轮已取消，agent 未执行任何修改操作。",
    });
  });

  it("prompt 失败时落错误系统提示，stopReason 置空", async () => {
    bindWith(() => Promise.reject(new Error("连接中断")));
    useSessionStore.getState().sendPrompt("会失败");
    await vi.waitFor(() => {
      expect(useSessionStore.getState().isAgentRunning).toBe(false);
    });
    const systems = useSessionStore
      .getState()
      .items.filter((item) => item.kind === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatchObject({
      level: "error",
      text: "本轮请求失败：连接中断",
    });
    expect(useSessionStore.getState().lastStopReason).toBeNull();
  });

  it("requestCancel 调用绑定的 cancel（session/cancel）；未运行时为 no-op", () => {
    const { cancel } = bindWith(
      () => new Promise<{ stopReason: "end_turn" }>(() => undefined),
    );
    useSessionStore.getState().requestCancel();
    expect(cancel).not.toHaveBeenCalled();
    useSessionStore.getState().sendPrompt("跑起来");
    useSessionStore.getState().requestCancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("无绑定时 sendPrompt 如实提示且不落用户消息", () => {
    useSessionStore.getState().sendPrompt("没有连接");
    const state = useSessionStore.getState();
    expect(state.isAgentRunning).toBe(false);
    const systems = state.items.filter((item) => item.kind === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]?.text).toContain("尚未连接 agent");
  });
});

describe("回放脚本（公开轮次入口 + 事件归约）", () => {
  it("回放脚本走真实归约产出完整会话", () => {
    replaySampleConversation();
    const state = useSessionStore.getState();
    const kinds = state.items.map((item) => item.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("thought");
    expect(
      kinds.filter((kind) => kind === "assistant").length,
    ).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((kind) => kind === "tool").length).toBe(3);
    expect(state.modelLabel).toBe("glm-4.7-coding");
    expect(state.approvalMode).toEqual({ id: "manual", name: "手动审批" });
    expect(state.isAgentRunning).toBe(false);
    expect(state.lastStopReason).toBe("end_turn");
    // 轮次收尾后流式条目全部封口
    for (const item of state.items) {
      if (item.kind === "assistant" || item.kind === "thought") {
        expect(item.isStreaming).toBe(false);
      }
    }
  });

  it("beginTurn 追加不清理既有条目（幂等约定）", () => {
    useSessionStore.getState().beginTurn("第一轮");
    useSessionStore.getState().beginTurn("第二轮");
    const users = useSessionStore
      .getState()
      .items.filter((item) => item.kind === "user");
    expect(
      users.map((item) => (item.kind === "user" ? item.text : "")),
    ).toEqual(["第一轮", "第二轮"]);
  });

  it("重复回放同一脚本条目追加（调用方负责 clear）", () => {
    replaySampleConversation();
    const first = useSessionStore.getState().items.length;
    replaySampleConversation();
    expect(useSessionStore.getState().items.length).toBeGreaterThan(first);
  });

  it("endTurn 的非 end_turn 停止原因落系统提示并复位运行态", () => {
    useSessionStore.getState().beginTurn("跑一轮");
    useSessionStore.getState().endTurn({ stopReason: "cancelled" });
    const state = useSessionStore.getState();
    expect(state.isAgentRunning).toBe(false);
    expect(state.lastStopReason).toBe("cancelled");
    const systems = state.items.filter(
      (item): item is SystemNoticeItem => item.kind === "system",
    );
    expect(systems).toHaveLength(2);
    expect(systems[0]).toMatchObject({ level: "warn", text: "本轮已取消" });
    // 结案卡：本轮无写类操作时的零操作交代
    expect(systems[1]).toMatchObject({
      level: "warn",
      text: "本轮已取消，agent 未执行任何修改操作。",
    });
  });
});

describe("端到端：AcpSession × EchoAgent × attachSession", () => {
  it("真实协议通路：prompt 事件流折叠 + cancel 结束轮次", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const session = new AcpSession(client);
    await session.initialize({ timeoutMs: 1_000 });
    await session.newSession("D:/work", { timeoutMs: 1_000 });
    const detach = attachSession(session);

    agent.script({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "开始检查。" },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "e1",
          title: "read desktop/src/App.tsx",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "desktop/src/App.tsx" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          rawOutput: "文件内容……",
        },
      ],
      hangUntilCancelled: true,
    });
    useSessionStore.getState().sendPrompt("检查一下");
    await vi.waitFor(() => {
      expect(useSessionStore.getState().isAgentRunning).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        useSessionStore.getState().items.some((item) => item.kind === "tool"),
      ).toBe(true);
    });

    useSessionStore.getState().requestCancel();
    await vi.waitFor(() => {
      expect(useSessionStore.getState().isAgentRunning).toBe(false);
    });
    expect(useSessionStore.getState().lastStopReason).toBe("cancelled");
    // EchoAgent 确实收到了 session/cancel 通知
    expect(
      agent.receivedNotifications.some(
        (entry) => entry.method === "session/cancel",
      ),
    ).toBe(true);

    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
      "system",
    ]);
    expect(items[2]).toMatchObject({
      title: "read desktop/src/App.tsx",
      status: "completed",
      inputSummary: "path=desktop/src/App.tsx",
      resultSummary: "文件内容……",
    });

    detach();
    expect(useSessionStore.getState().isBound).toBe(false);
    await session.close();
  });
});

describe("会话列表：setSessions / openSession", () => {
  const sampleSessions = [
    {
      id: "echo-1",
      title: "工作区会话",
      updatedAt: "2026-10-20T10:00:00Z",
    },
    {
      id: "echo-2",
      title: "另一会话",
      updatedAt: null,
    },
  ];

  it("setSessions 回填并自动聚焦首项；聚焦会话从列表消失时回落首项", () => {
    useSessionStore.getState().setSessions(sampleSessions);
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe("echo-1");

    state.openSession("echo-2");
    expect(useSessionStore.getState().activeSessionId).toBe("echo-2");

    // echo-2 被移除后聚焦回落到剩余首项
    useSessionStore.getState().setSessions([sampleSessions[0]!]);
    expect(useSessionStore.getState().activeSessionId).toBe("echo-1");
  });

  it("openSession 拒绝列表外的会话；dismissSession 清空聚焦", () => {
    useSessionStore.getState().setSessions(sampleSessions);
    useSessionStore.getState().openSession("不存在的会话");
    expect(useSessionStore.getState().activeSessionId).toBe("echo-1");
    useSessionStore.getState().dismissSession();
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it("setSessions 带路径回填同步各项目列表缓存；无路径回填（断开）保留缓存", () => {
    useSessionStore.getState().setSessions(sampleSessions, "D:/dev/demo");
    expect(
      useSessionStore.getState().sessionsByPath["D:/dev/demo"],
    ).toHaveLength(2);

    // 断开场景：清空当前列表（聚焦回落），但树用的各项目缓存保留
    useSessionStore.getState().setSessions([]);
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(
      useSessionStore.getState().sessionsByPath["D:/dev/demo"],
    ).toHaveLength(2);

    // 另一项目回填互不覆盖
    useSessionStore
      .getState()
      .setSessions([sampleSessions[0]!], "D:/dev/other");
    expect(
      useSessionStore.getState().sessionsByPath["D:/dev/demo"],
    ).toHaveLength(2);
    expect(
      useSessionStore.getState().sessionsByPath["D:/dev/other"],
    ).toHaveLength(1);
  });

  it("mergeSessionHistory 只补空缺项目，不覆盖 session/list 的权威快照", () => {
    // 已连接过的项目：session/list 回填的权威列表（含刚建的新会话）
    useSessionStore
      .getState()
      .setSessions([sampleSessions[0]!], "D:/dev/connected");
    // 未连接的项目只能靠会话索引补充；同一张映射里两者都在，
    // 已连接的那个必须原样不动（缓存有节流写入，可能落后几十秒）
    useSessionStore.getState().mergeSessionHistory({
      "D:/dev/connected": sampleSessions,
      "D:/dev/fresh": sampleSessions,
    });

    const cached = useSessionStore.getState().sessionsByPath;
    expect(cached["D:/dev/connected"]).toHaveLength(1);
    expect(cached["D:/dev/fresh"]).toHaveLength(2);
  });

  it("mergeSessionHistory 空映射与空列表都不写入（读不到 ≠ 没有会话）", () => {
    useSessionStore.setState({ sessionsByPath: {} });
    useSessionStore.getState().mergeSessionHistory({});
    expect(useSessionStore.getState().sessionsByPath).toEqual({});

    useSessionStore.getState().mergeSessionHistory({ "D:/dev/empty": [] });
    expect(useSessionStore.getState().sessionsByPath).toEqual({});
  });
});

describe("会话标题（sessionTitleOf）", () => {
  it("取首条用户消息前 24 字符（折叠空白），不含 UUID", () => {
    const long = "帮我检查登录接口为什么返回 401，并修复测试里的过期 token。";
    const title = sessionTitleOf([
      { kind: "user", id: "u1", text: long, createdAt: "" },
    ]);
    expect(title).toBe(`会话 · ${long.slice(0, 24)}`);
    expect(title).not.toMatch(/[0-9a-f]{8}-/);
  });

  it("首条用户消息为空白时跳过；历史为空回落时间（HH:MM）", () => {
    const skipped = sessionTitleOf(
      [
        { kind: "user", id: "u1", text: "   ", createdAt: "" },
        { kind: "user", id: "u2", text: "真正的问题", createdAt: "" },
      ],
      new Date(2026, 9, 20, 9, 7),
    );
    expect(skipped).toBe("会话 · 真正的问题");
    expect(sessionTitleOf([], new Date(2026, 9, 20, 9, 7))).toBe(
      "会话 · 09:07",
    );
  });
});

describe("会话消息快照持久化（session-log）", () => {
  const WORKSPACE = "D:/work";
  const LOG_KEY = `aaw-desktop/session-log/${encodeURIComponent(WORKSPACE)}`;

  function readStoredItems(): unknown[] {
    const raw = window.localStorage.getItem(LOG_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { items: unknown[] };
    return parsed.items;
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("endTurn 即时落盘；restoreSessionLog 把快照灌回（流式标记封口）", () => {
    useSessionStore.getState().setSessionLogTarget(WORKSPACE);
    useSessionStore.getState().beginTurn("第一问");
    feed([chunk("第一答"), thought("推理中")]);
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });

    // 落盘形状：条目种类齐全且流式标记封口
    const stored = readStoredItems();
    expect(stored.map((item) => (item as { kind: string }).kind)).toEqual([
      "user",
      "assistant",
      "thought",
    ]);

    // 清空后经专用 restore action 灌回（不触发协议副作用）
    useSessionStore.getState().clear();
    expect(useSessionStore.getState().items).toHaveLength(0);
    useSessionStore.getState().restoreSessionLog(WORKSPACE);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "thought",
    ]);
    expect(items[1]).toMatchObject({ text: "第一答", isStreaming: false });
    expect(items[2]).toMatchObject({ text: "推理中", isStreaming: false });
  });

  it("handleEvent 增量按 2s 节流落盘", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.getState().setSessionLogTarget(WORKSPACE);
      feed([chunk("增量一")]);
      // 节流窗口内不写盘
      expect(window.localStorage.getItem(LOG_KEY)).toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(readStoredItems()).toHaveLength(1);
      // 节流窗口内的后续增量合并进同一次写入（拼接进同一条流式条目）
      feed([chunk("增量二")]);
      vi.advanceTimersByTime(2_000);
      const stored = readStoredItems();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ text: "增量一增量二" });
    } finally {
      vi.useRealTimers();
      useSessionStore.getState().setSessionLogTarget(null);
    }
  });

  it("条目上限 200：只保留最新 200 条", () => {
    useSessionStore.getState().setSessionLogTarget(WORKSPACE);
    for (let index = 0; index < 210; index += 1) {
      useSessionStore.getState().beginTurn(`消息 ${index}`);
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
    }
    const stored = readStoredItems();
    expect(stored).toHaveLength(200);
    expect(stored[0]).toMatchObject({ text: "消息 10" });
    expect(stored[199]).toMatchObject({ text: "消息 209" });
  });

  it("clear 取消挂起的节流落盘（空条目不覆盖既有快照）", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.getState().setSessionLogTarget(WORKSPACE);
      useSessionStore.getState().beginTurn("已收尾");
      useSessionStore.getState().endTurn({ stopReason: "end_turn" });
      const before = window.localStorage.getItem(LOG_KEY);
      // 未收尾的增量排定了 2s 后的落盘
      feed([chunk("未收尾增量")]);
      useSessionStore.getState().clear();
      vi.advanceTimersByTime(5_000);
      // 定时器被 clear 取消：快照不会被空条目覆盖
      expect(window.localStorage.getItem(LOG_KEY)).toBe(before);
    } finally {
      vi.useRealTimers();
      useSessionStore.getState().setSessionLogTarget(null);
    }
  });

  it("system 条目（错误提示等即时反馈）不进快照、恢复时丢弃", () => {
    // 保存侧：无绑定发送触发 system 错误条目，当场可见但快照里不出现
    useSessionStore.getState().setSessionLogTarget(WORKSPACE);
    useSessionStore.getState().sendPrompt("这条会失败");
    expect(
      useSessionStore.getState().items.some((item) => item.kind === "system"),
    ).toBe(true);
    useSessionStore.getState().setSessionLogTarget(null); // 收口落盘
    expect(
      readStoredItems().some(
        (item) => (item as { kind: string }).kind === "system",
      ),
    ).toBe(false);

    // 恢复侧：旧版本快照里已存的 system 条目一律丢弃（历史脏数据自愈）
    window.localStorage.setItem(
      LOG_KEY,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        items: [
          {
            kind: "system",
            id: "system-1",
            level: "error",
            text: "尚未连接 agent",
          },
          { kind: "user", id: "user-1", text: "真实历史", createdAt: "" },
        ],
      }),
    );
    useSessionStore.getState().clear();
    useSessionStore.getState().restoreSessionLog(WORKSPACE);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual(["user"]);
    expect(items[0]).toMatchObject({ text: "真实历史" });
  });

  it("快照损坏时按无历史处理（restoreSessionLog 不清空现有条目）", () => {
    window.localStorage.setItem(LOG_KEY, "{不是 JSON");
    useSessionStore.getState().beginTurn("现场保留");
    useSessionStore.getState().restoreSessionLog(WORKSPACE);
    const items = useSessionStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "现场保留" });
  });

  it("restoreItems 直接置换条目流并复位运行态（切换失败回滚用）", () => {
    useSessionStore.getState().beginTurn("原会话");
    feed([chunk("原回复")]);
    const snapshot = useSessionStore.getState().items;
    useSessionStore.getState().clear();
    expect(useSessionStore.getState().items).toHaveLength(0);

    useSessionStore.getState().restoreItems(snapshot);
    const items = useSessionStore.getState().items;
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(items[1]).toMatchObject({ text: "原回复", isStreaming: false });
    expect(useSessionStore.getState().isAgentRunning).toBe(false);
    // restore 不触碰下行通道绑定
    expect(useSessionStore.getState().isBound).toBe(false);
  });

  it("未设定目标时 handleEvent / endTurn 不写盘", () => {
    useSessionStore.getState().beginTurn("无目标");
    feed([chunk("无目标回复")]);
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });
    expect(window.localStorage.getItem(LOG_KEY)).toBeNull();
  });
});

describe("条目时间字段（M1：耗时与时间戳）", () => {
  type ToolEntry = Extract<SessionItem, { kind: "tool" }>;
  type AssistantEntry = Extract<SessionItem, { kind: "assistant" }>;

  function toolAt(index: number): ToolEntry {
    const items = useSessionStore.getState().items;
    const item = items[index];
    if (item === undefined || item.kind !== "tool") {
      throw new Error(`第 ${index} 条不是工具条目：${String(item?.kind)}`);
    }
    return item;
  }

  function assistantWhere(
    predicate: (entry: AssistantEntry) => boolean,
  ): AssistantEntry {
    const found = useSessionStore
      .getState()
      .items.find(
        (item): item is AssistantEntry =>
          item.kind === "assistant" && predicate(item),
      );
    if (found === undefined) {
      throw new Error("没有匹配的助手条目");
    }
    return found;
  }

  it("工具卡落笔即记起点；首次进入终态定格终点，后续 update 不覆盖", () => {
    feed([
      {
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "t1",
        title: "run npm test",
        status: "in_progress",
      },
    ]);
    const created = toolAt(0);
    expect(typeof created.startedAt).toBe("number");
    expect(created.endedAt).toBeNull();

    feed([
      {
        type: "tool_call_update",
        sessionId: "s1",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "ok",
      },
    ]);
    const done = toolAt(0);
    expect(done.status).toBe("completed");
    const startedAt = created.startedAt;
    if (startedAt === null) {
      throw new Error("起点缺失");
    }
    const endedAt = done.endedAt;
    if (endedAt === null) {
      throw new Error("终点缺失");
    }
    expect(endedAt).toBeGreaterThanOrEqual(startedAt);

    // 再次 completed update（补发输出等）：终点保持定格
    feed([
      {
        type: "tool_call_update",
        sessionId: "s1",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "ok, with more",
      },
    ]);
    expect(toolAt(0).endedAt).toBe(endedAt);
  });

  it("落笔即终态：起止同刻（耗时 0），不误报为运行中", () => {
    feed([
      {
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "t-late",
        title: "instant",
        status: "completed",
      },
    ]);
    const item = toolAt(0);
    expect(item.status).toBe("completed");
    expect(typeof item.startedAt).toBe("number");
    expect(typeof item.endedAt).toBe("number");
  });

  it("助手消息落笔带 createdAt（hover 时间戳用）", () => {
    feed([chunk("带时间戳的回复")]);
    const item = assistantWhere(() => true);
    expect(item.text).toBe("带时间戳的回复");
    expect(item.createdAt.length).toBeGreaterThan(0);
  });

  it("快照往返保留工具起止时刻与助手 createdAt", () => {
    const WORKSPACE = "D:/work-ts";
    const LOG_KEY = `aaw-desktop/session-log/${encodeURIComponent(WORKSPACE)}`;
    useSessionStore.getState().setSessionLogTarget(WORKSPACE);
    feed([
      {
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "t1",
        title: "run",
        status: "in_progress",
      },
      chunk("回复正文"),
    ]);
    feed([
      {
        type: "tool_call_update",
        sessionId: "s1",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "done",
      },
    ]);
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });
    const raw = window.localStorage.getItem(LOG_KEY);
    expect(raw).not.toBeNull();

    useSessionStore.getState().setSessionLogTarget(null);
    useSessionStore.getState().clear();
    useSessionStore.getState().restoreSessionLog(WORKSPACE);
    const items = useSessionStore.getState().items;
    const tool = items.find((item) => item.kind === "tool");
    if (tool === undefined || tool.kind !== "tool") {
      throw new Error("快照恢复后没有工具条目");
    }
    expect(typeof tool.startedAt).toBe("number");
    expect(typeof tool.endedAt).toBe("number");
    const assistant = items.find((item) => item.kind === "assistant");
    if (assistant === undefined || assistant.kind !== "assistant") {
      throw new Error("快照恢复后没有助手条目");
    }
    expect(assistant.createdAt.length).toBeGreaterThan(0);
  });
});

describe("plan 步骤清单（流内条目，ACP plan 事件归约）", () => {
  const planEvent = (
    entries: readonly { content: string; status: string }[],
  ): Extract<AcpSessionEvent, { type: "plan" }> => ({
    type: "plan",
    sessionId: "s1",
    entries: entries.map((entry) => ({
      content: entry.content,
      priority: "medium" as const,
      status: entry.status as "pending" | "in_progress" | "completed",
    })),
  });

  function planItems() {
    return useSessionStore
      .getState()
      .items.filter(
        (item): item is Extract<SessionItem, { kind: "plan" }> =>
          item.kind === "plan",
      );
  }

  it("落卡进消息流；后续整表更新刷新同一张卡", () => {
    feed([
      planEvent([
        { content: "第一步", status: "completed" },
        { content: "第二步", status: "in_progress" },
      ]),
    ]);
    expect(planItems()).toHaveLength(1);

    feed([
      planEvent([
        { content: "第二步", status: "completed" },
        { content: "第三步", status: "pending" },
      ]),
    ]);
    const cards = planItems();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.entries.map((entry) => entry.content)).toEqual([
      "第二步",
      "第三步",
    ]);
  });

  it("上一张全部完成后再来新清单：落新卡不改写历史；空清单 no-op", () => {
    feed([
      planEvent([
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
      ]),
    ]);
    feed([
      planEvent([
        { content: "新任务一", status: "in_progress" },
        { content: "新任务二", status: "pending" },
      ]),
    ]);
    const cards = planItems();
    expect(cards).toHaveLength(2);
    expect(cards[0]?.entries[0]?.content).toBe("A");
    expect(cards[1]?.entries[0]?.content).toBe("新任务一");

    // 空 entries（todo_write 清空）：不改流
    const before = useSessionStore.getState().items.length;
    feed([planEvent([])]);
    expect(useSessionStore.getState().items.length).toBe(before);
  });

  it("快照往返保留 plan 卡与条目状态", () => {
    const WORKSPACE = "D:/work-plan";
    const LOG_KEY = `aaw-desktop/session-log/${encodeURIComponent(WORKSPACE)}`;
    useSessionStore.getState().setSessionLogTarget(WORKSPACE);
    useSessionStore.getState().beginTurn("带清单的任务");
    feed([
      planEvent([
        { content: "甲", status: "completed" },
        { content: "乙", status: "in_progress" },
      ]),
    ]);
    useSessionStore.getState().endTurn({ stopReason: "end_turn" });
    expect(window.localStorage.getItem(LOG_KEY)).not.toBeNull();

    useSessionStore.getState().setSessionLogTarget(null);
    useSessionStore.getState().clear();
    useSessionStore.getState().restoreSessionLog(WORKSPACE);
    const restored = planItems();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.sourceSessionId).toBe("s1");
    expect(restored[0]?.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "in_progress",
    ]);
  });

  it("不同会话的 plan 不能覆盖上一会话的未完成历史卡", () => {
    feed([planEvent([{ content: "旧会话计划", status: "pending" }])]);
    feed([
      {
        ...planEvent([{ content: "新会话计划", status: "in_progress" }]),
        sessionId: "s2",
      },
    ]);
    expect(planItems().map((item) => item.sourceSessionId)).toEqual([
      "s1",
      "s2",
    ]);
    expect(planItems()[0]?.entries[0]?.content).toBe("旧会话计划");
  });
});

describe("会话标题：原生跟随 + 手动覆盖层", () => {
  const PATH = "D:/dev/title-demo";
  const listEntry = (id: string, title: string) => ({
    id,
    title,
    nativeTitle: title,
    updatedAt: null,
  });

  beforeEach(() => {
    window.localStorage.clear();
    useSessionStore.getState().clear();
    useSessionStore.setState({
      activeSessionId: "sess-1",
      sessions: [listEntry("sess-1", "原生标题A"), listEntry("sess-2", "原生标题B")],
      sessionsByPath: {
        [PATH]: [listEntry("sess-1", "原生标题A"), listEntry("sess-2", "原生标题B")],
      },
    });
  });

  it("session_info_update 跟随更新会话列表与树缓存的原生名", () => {
    useSessionStore.getState().handleEvent({
      type: "session_info_update",
      sessionId: "sess-1",
      title: "AI 改的新标题",
      updatedAt: "2026-10-28T10:00:00Z",
    });
    const state = useSessionStore.getState();
    expect(state.sessions.find((s) => s.id === "sess-1")?.title).toBe(
      "AI 改的新标题",
    );
    expect(state.sessionsByPath[PATH]?.[0]?.title).toBe("AI 改的新标题");
    // 原生名同时被记住（悬停展示 / 清除手动名后恢复）
    expect(state.sessions.find((s) => s.id === "sess-1")?.nativeTitle).toBe(
      "AI 改的新标题",
    );
  });

  it("手动改名压制原生跟随；后续 session_info_update 只更新原生名不改展示", () => {
    const store = useSessionStore.getState();
    store.renameSession("sess-1", "我的名字");
    store.handleEvent({
      type: "session_info_update",
      sessionId: "sess-1",
      title: "AI 又改了",
    });
    const entry = useSessionStore.getState().sessions.find((s) => s.id === "sess-1");
    expect(entry?.title).toBe("我的名字");
    expect(entry?.nativeTitle).toBe("AI 又改了");
  });

  it("清空提交清除手动名，恢复跟随原生名", () => {
    useSessionStore.getState().renameSession("sess-1", "我的名字");
    useSessionStore.getState().renameSession("sess-1", "   ");
    const entry = useSessionStore.getState().sessions.find((s) => s.id === "sess-1");
    expect(entry?.title).toBe("原生标题A");
  });

  it("setSessions 入口即套覆盖层（agent 回填列表也显示手动名）", () => {
    useSessionStore.getState().renameSession("sess-2", "手动优先");
    useSessionStore.getState().setSessions(
      [listEntry("sess-1", "原生标题A"), listEntry("sess-2", "原生标题B")],
      PATH,
    );
    const state = useSessionStore.getState();
    expect(state.sessions.find((s) => s.id === "sess-2")?.title).toBe("手动优先");
    expect(state.sessionsByPath[PATH]?.[1]?.title).toBe("手动优先");
    expect(state.sessions.find((s) => s.id === "sess-2")?.nativeTitle).toBe(
      "原生标题B",
    );
  });
});
