import { useSessionStore, useApprovalStore, useRuntimeStatusStore } from "../../../helpers/foreground.ts";
import { createOwnedSession, sessionConnection } from "../../../helpers/ownedSession.ts";
/** 长任务、取消及会话切换的生命周期回归；虚拟时间覆盖原 90 秒故障。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSession } from "../../../../src/plugins/acpRuntime/protocol/session.ts";
import { JsonRpcConnection } from "../../../../src/plugins/acpConnection/protocol/JsonRpcConnection.ts";
import {
  AcpClosedError,
  AcpTimeoutError,
  AcpWriteError,
} from "../../../../src/plugins/acpRuntime/service.ts";
import { EchoAgent } from "../../../helpers/echo-agent.ts";
import { createTransportPair } from "../../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import type { PromptResult } from "../../../../src/contracts/acp/protocol.ts";
import { TURN_IDLE_NOTICE_MS } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { attachSessionViews } from "../../../../src/plugins/project/conversation/projection.ts";

const store = useSessionStore;
let detach: (() => void) | undefined;
let session: AcpSession | undefined;

function deferred() {
  let resolve!: (result: PromptResult) => void;
  const promise = new Promise<PromptResult>((done) => {
    resolve = done;
  });
  const prompt = vi.fn(() => promise);
  const cancel = vi.fn();
  store.getState().bindSession({ prompt, cancel });
  return { resolve, prompt, cancel };
}

async function connect() {
  const { client, peer } = createTransportPair();
  const agent = new EchoAgent();
  agent.attach(peer);
  session = createOwnedSession(client);
  await session.initialize();
  await session.newSession("D:/work");
  detach = attachSessionViews(session, store, useApprovalStore, useRuntimeStatusStore);
  return { agent, peer, session };
}

beforeEach(() => {
  store.getState().clear();
  store.getState().bindSession(null);
  store.setState({ isConnecting: false, agentCrashed: null });
  useApprovalStore.getState().clear();
});

afterEach(async () => {
  detach?.();
  detach = undefined;
  store.getState().clear();
  store.getState().bindSession(null);
  useApprovalStore.getState().clear();
  vi.useRealTimers();
  await (session ? sessionConnection(session).close() : undefined);
  session = undefined;
});

describe("轮次等待与明确终态", () => {
  it.each(["cancelled", "end_turn"] as const)(
    "点击停止立即暂停队列，最终返回 %s 也必须手动继续",
    async (stopReason) => {
      const binding = deferred();
      store.getState().sendPrompt("第一条");
      store.getState().enqueuePrompt("第二条");
      store.getState().requestCancel();
      expect(store.getState()).toMatchObject({
        queuePaused: true,
        isAgentRunning: true,
      });
      binding.resolve({ stopReason });
      await Promise.resolve();
      expect(binding.prompt).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({
        queuePaused: true,
        queuedPrompts: ["第二条"],
        isAgentRunning: false,
      });
      store.getState().resumeQueue();
      expect(binding.prompt).toHaveBeenCalledTimes(2);
      expect(binding.prompt).toHaveBeenLastCalledWith("第二条");
      await Promise.resolve();
    },
  );

  it("点击停止后才入队，也不会因当前轮正常完成而续发", async () => {
    const binding = deferred();
    store.getState().sendPrompt("第一条");
    store.getState().requestCancel();
    store.getState().enqueuePrompt("停止后排队");
    binding.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    expect(binding.prompt).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      queuePaused: true,
      queuedPrompts: ["停止后排队"],
    });
    // 用户单独发送另一轮也不等于放行队列。
    store.getState().sendPrompt("单独发送");
    await Promise.resolve();
    expect(binding.prompt).toHaveBeenCalledTimes(2);
    expect(store.getState().queuedPrompts).toEqual(["停止后排队"]);
  });

  it("暂停期间连接不可用，手动继续不会丢掉队首消息", async () => {
    const binding = deferred();
    store.getState().sendPrompt("第一条");
    store.getState().enqueuePrompt("第二条");
    store.getState().requestCancel();
    binding.resolve({ stopReason: "cancelled" });
    await Promise.resolve();
    store.getState().bindSession(null);
    store.getState().resumeQueue();
    expect(store.getState()).toMatchObject({
      queuePaused: true,
      queuedPrompts: ["第二条"],
    });
    expect(binding.prompt).toHaveBeenCalledTimes(1);
  });

  it("匀速吐字泵：突发大分片逐帧上屏（先部分后全量），封口不丢字", async () => {
    const { agent } = await connect();
    const bigText = "字".repeat(500);
    agent.script({
      interDelayMs: 30,
      // 挂起到取消：turn 活着，泵才有「部分上屏」的表演窗口（短 turn 会
      // 立即封口全量排空，测不到中间态）
      hangUntilCancelled: true,
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "你好" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: bigText },
        },
      ],
    });
    store.getState().sendPrompt("吐字泵");
    // 真实时钟轮询「部分上屏」状态：吐字泵逐帧搬运，不会整段砸出来
    const samples: string[] = [];
    const startedAt = Date.now();
    const partial = await new Promise<number | undefined>((resolve) => {
      const poll = setInterval(() => {
        const item = store
          .getState()
          .items.find((candidate) => candidate.kind === "assistant");
        const len = item?.text.length ?? 0;
        samples.push(`${Date.now() - startedAt}ms:${len}`);
        if (len >= 8 && len < 2 + 500) {
          clearInterval(poll);
          resolve(len);
        } else if (Date.now() - startedAt > 3000) {
          clearInterval(poll);
          console.log("[pump-samples]", samples.join(" | "));
          resolve(undefined);
        }
      }, 40);
    });
    expect(partial).toBeDefined();

    // 泵持续搬运：缓冲全部上屏（挂起中的 turn 也能吐完，一个字不丢）
    await vi.waitFor(
      () => {
        const item = store
          .getState()
          .items.find((candidate) => candidate.kind === "assistant");
        expect(item?.text).toBe(`你好${bigText}`);
      },
      { timeout: 5000, interval: 50 },
    );

    // 收尾：取消挂起轮次（分片缓冲已排空，取消不影响已上屏内容）
    store.getState().requestCancel();
    await vi.waitFor(() => {
      expect(store.getState().isAgentRunning).toBe(false);
    });
  });

  it("持续输出超过 90 秒，最终响应仍收尾且没有错误残留", async () => {
    const { agent } = await connect();
    vi.useFakeTimers();
    agent.script({
      interDelayMs: 60_000,
      updates: Array.from({ length: 4 }, () => ({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "继续" },
      })),
    });
    store.getState().sendPrompt("长任务");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(store.getState()).toMatchObject({
      isAgentRunning: true,
      isWaitingForActivity: false,
      turnError: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState()).toMatchObject({
      isAgentRunning: false,
      turnState: "completed",
      lastStopReason: "end_turn",
      turnError: null,
    });
    expect(store.getState().items).toContainEqual(
      expect.objectContaining({
        kind: "assistant",
        text: "继续继续继续继续",
        isStreaming: false,
      }),
    );
    expect(store.getState().items.some((item) => item.kind === "system")).toBe(
      false,
    );
  });

  it("无输出超过 90 秒不打扰慢模型；迟到的内容和完成响应仍正常接收", async () => {
    const { agent } = await connect();
    vi.useFakeTimers();
    agent.script({
      interDelayMs: 180_000,
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "完成" },
        },
      ],
    });
    store.getState().sendPrompt("慢工具");
    await vi.advanceTimersByTimeAsync(TURN_IDLE_NOTICE_MS);
    expect(store.getState()).toMatchObject({
      isAgentRunning: true,
      isWaitingForActivity: false,
      turnError: null,
    });
    await vi.advanceTimersByTimeAsync(TURN_IDLE_NOTICE_MS);
    expect(store.getState()).toMatchObject({
      turnState: "completed",
      isWaitingForActivity: false,
      turnError: null,
    });
  });

  it("等待人工回答与回答后都不做无消息超时提醒", async () => {
    const { agent, session: active } = await connect();
    vi.useFakeTimers();
    agent.script({ hangUntilCancelled: true });
    store.getState().sendPrompt("等待用户");
    const answer = useApprovalStore.getState().offerQuestions({
      sessionId: active.sessionId!,
      requestId: "q",
      callerName: "test",
      questions: [],
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.getState()).toMatchObject({
      isAwaitingUser: true,
      isWaitingForActivity: false,
      isAgentRunning: true,
    });
    useApprovalStore.getState().clear();
    await answer;
    expect(store.getState().isAwaitingUser).toBe(false);
    await vi.advanceTimersByTimeAsync(TURN_IDLE_NOTICE_MS);
    expect(store.getState().isWaitingForActivity).toBe(false);
    store.getState().requestCancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().turnState).toBe("cancelled");
  });

  it.each(["cancelled", "end_turn"] as const)(
    "取消等待确认，最终以 %s 响应为准",
    async (stopReason) => {
      const binding = deferred();
      store.getState().sendPrompt("任务");
      store.getState().sendPrompt("重复任务");
      store.getState().requestCancel();
      store.getState().requestCancel();
      store.getState().sendPrompt("取消期间重复任务");
      expect(binding.prompt).toHaveBeenCalledTimes(1);
      expect(binding.cancel).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({
        turnState: "cancelling",
        isAgentRunning: true,
        lastStopReason: null,
      });
      binding.resolve({ stopReason });
      await Promise.resolve();
      expect(store.getState()).toMatchObject({
        isAgentRunning: false,
        lastStopReason: stopReason,
        turnState: stopReason === "cancelled" ? "cancelled" : "completed",
      });
    },
  );

  it("旧请求迟到不能结束新会话的轮次", async () => {
    const old = deferred();
    store.getState().sendPrompt("旧会话");
    store.getState().clear();
    const current = deferred();
    store.getState().sendPrompt("新会话");
    old.resolve({ stopReason: "cancelled" });
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      isAgentRunning: true,
      turnState: "running",
      lastStopReason: null,
    });
    expect(store.getState().items).toHaveLength(1);
    current.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    expect(store.getState().turnState).toBe("completed");
  });

  it("进程退出结束无总时限的请求并封口，禁止向死连接发送", async () => {
    const { agent, peer } = await connect();
    agent.script({ hangUntilCancelled: true });
    store.getState().sendPrompt("任务");
    peer.exit(1);
    await vi.waitFor(() => expect(store.getState().turnState).toBe("unknown"));
    expect(store.getState()).toMatchObject({
      isAgentRunning: true,
      queuePaused: true,
    });
    expect(store.getState().connectionFailure).not.toBeNull();
  });

  it("等待异常表示状态未知，重试不会重复执行", async () => {
    const prompt = vi.fn(() =>
      Promise.reject(new AcpTimeoutError("session/prompt", 90_000)),
    );
    store.getState().bindSession({ prompt, cancel: vi.fn() });
    store.getState().sendPrompt("任务");
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      turnState: "unknown",
      isAgentRunning: true,
      turnError: null,
    });
    store.getState().retryLastPrompt();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("取消发送失败不伪造取消成功，后续完成响应仍有效", async () => {
    const pending = deferred();
    store.getState().bindSession({
      prompt: pending.prompt,
      cancel: () => {
        throw new AcpWriteError("写入失败");
      },
    });
    store.getState().sendPrompt("任务");
    store.getState().requestCancel();
    expect(store.getState()).toMatchObject({
      turnState: "unknown",
      isAgentRunning: true,
      lastStopReason: null,
    });
    pending.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    expect(store.getState().turnState).toBe("completed");
  });

  it("短请求仍有超时；无时限请求在退出时也能释放", async () => {
    const { client, peer } = createTransportPair();
    const connection = new JsonRpcConnection(client);
    vi.useFakeTimers();
    const short = connection
      .request("initialize")
      .catch((error: unknown) => error);
    const long = connection
      .request("session/prompt", {}, { timeoutMs: null })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await short).toBeInstanceOf(AcpTimeoutError);
    peer.exit(1);
    expect(await long).toBeInstanceOf(AcpClosedError);
    expect(() =>
      connection.notify("session/cancel", {}, { throwOnError: true }),
    ).toThrow(AcpClosedError);
  });
});
