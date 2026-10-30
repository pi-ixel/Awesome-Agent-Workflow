/**
 * src/ui/agentProbe 测试：用进程内 echo-agent（讲 chrys 方言）+ 内存
 * transport 跑探查全链路，不碰真实子进程——
 *
 * - 安全探查：握手/能力/模型清单/早期通知（chrys_runtime、chrys_usage）/
 *   session/list 实测/close 确认全部落入结果；
 * - 深度探查：脚本化一轮对话，消息 chunk 与工具 kind 计入观测；
 * - 握手失败：ok=false + failedStep，且不抛出。
 */
import { describe, expect, it } from "vitest";
import { EchoAgent } from "../../src/acp/mock/echo-agent";
import { createTransportPair } from "../../src/acp/transport/inMemoryTransport";
import { chrysAgentAdapter } from "../../src/agents/registry";
import { runAgentProbe, testAgentConnection } from "../../src/ui/agentProbe";

const CWD = "X:/workspaces/demo";

describe("连接测试", () => {
  it("只握手，不创建会话，收集进程输出并关闭", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    const methods: string[] = [];
    peer.onLine((line) => {
      methods.push((JSON.parse(line) as { method: string }).method);
    });
    const resultPromise = testAgentConnection(
      chrysAgentAdapter,
      undefined,
      undefined,
      client,
    );
    peer.writeStderr("启动提示");
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.message).toContain("echo-agent");
    expect(result.stderr).toContain("启动提示");
    expect(methods).toEqual(["initialize"]);
    expect(client.isClosed).toBe(true);
  });

  it("握手失败时保留进程输出", async () => {
    const { client, peer } = createTransportPair();
    const pending = testAgentConnection(
      chrysAgentAdapter,
      undefined,
      undefined,
      client,
    );
    peer.writeStderr("示例启动错误");
    peer.exit(3);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ACP 握手失败");
    expect(result.stderr).toContain("示例启动错误");
  });
});

describe("runAgentProbe（echo-agent 闭环）", () => {
  it("安全探查：声明侧 + 早期通知 + list/close 全走通", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);

    const steps: string[] = [];
    const result = await runAgentProbe(chrysAgentAdapter, {
      depth: "safe",
      cwd: CWD,
      transport: client,
      onStep: (step) => {
        steps.push(step);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failedStep).toBeNull();
    expect(result.protocolVersion).toBe(1);
    expect(result.agentName).toBe("echo-agent");
    // 能力声明原样透传
    expect(result.capabilities?.["loadSession"]).toBe(true);
    // echo 的 session/new 回模型清单
    expect(result.models?.currentModelId).toBe("echo-model");
    // 早期通知：echo 在 session/new 后推 _chrys/runtime_update / usage_update
    expect(
      result.events.eventTypeCounts["chrys_runtime"],
    ).toBeGreaterThanOrEqual(1);
    expect(result.events.eventTypeCounts["chrys_usage"]).toBeGreaterThanOrEqual(
      1,
    );
    // session/list 实测：本次探查建的会话在列
    expect(result.list?.status).toBe("ok");
    expect(result.list?.count).toBeGreaterThanOrEqual(1);
    expect(result.closeAck).toBe(true);
    // 进度步骤覆盖主链路
    expect(steps).toContain("握手 initialize");
    expect(steps).toContain("关闭会话");
  });

  it("深度探查：两轮对话（轻量 + 多步）的消息/思考/工具事件计入观测", async () => {
    const { client, peer } = createTransportPair();
    // defaultTurnScript 覆盖两轮（script() 只对下一次 prompt 生效）
    const agent = new EchoAgent({
      defaultTurnScript: {
        updates: [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "完成" },
          },
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "想一下" },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "read",
            kind: "read",
            status: "in_progress",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    });
    agent.attach(peer);

    const result = await runAgentProbe(chrysAgentAdapter, {
      depth: "deep",
      cwd: CWD,
      transport: client,
    });

    expect(result.ok).toBe(true);
    // 两轮各有结论，且全部走通
    expect(result.prompts).toHaveLength(2);
    for (const turn of result.prompts) {
      expect(turn.status).toBe("ok");
      expect(turn.stopReason).toBe("end_turn");
    }
    expect(
      result.events.eventTypeCounts["agent_message_chunk"] ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(
      result.events.eventTypeCounts["agent_thought_chunk"] ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(result.events.toolKindCounts["read"]).toBeGreaterThanOrEqual(2);
  });

  it("握手失败：ok=false、failedStep 记录、函数不抛出", async () => {
    const { client, peer } = createTransportPair();
    // 不挂 echo：initialize 无人应答，进程随即退出 → AcpClosedError，
    // runner 收进 failedStep 而不是抛出
    setTimeout(() => {
      peer.exit(1);
    }, 10);

    const result = await runAgentProbe(chrysAgentAdapter, {
      depth: "safe",
      cwd: CWD,
      transport: client,
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("连接链路");
    expect(result.failureReason).toMatch(/Acp(Closed|Write)Error/);
    // 声明侧无数据（握手即败）
    expect(result.protocolVersion).toBeNull();
    expect(result.capabilities).toBeNull();
  });

  it("深度探查的对话失败是观测数据：链路整体仍 ok", async () => {
    const { client, peer } = createTransportPair();
    const agent = new EchoAgent();
    agent.attach(peer);
    // 模拟模型调用失败：脚本挂起（hangUntilCancelled）期间对端进程退出，
    // 对话请求被 AcpClosedError 拒绝——runner 把它记为对话轮失败
    // 而不是链路失败（链路 = 握手/建会话/list/close）
    agent.script({
      updates: [],
      stopReason: "end_turn",
      hangUntilCancelled: true,
    });
    const probePromise = runAgentProbe(chrysAgentAdapter, {
      depth: "deep",
      cwd: CWD,
      transport: client,
    });
    setTimeout(() => {
      peer.exit(1);
    }, 30);
    const result = await probePromise;

    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.prompts.every((turn) => turn.status === "failed")).toBe(true);
    expect(result.ok).toBe(true);
  });
});
