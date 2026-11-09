import type { AcpSessionEvent } from "../../src/contracts/acpSession.ts";
import { useRuntimeStatusStore } from "../helpers/foreground.ts";
import { normalizeChrysRuntime } from "../../src/plugins/agents/enhancements/icode/chrysRuntime.ts";
/**
 * runtimeStatusStore 测试：runtime 三形状的字段级合并（partial 不清旧值、
 * runtimeDetails 的 MCP/skill/model 收窄）、usage 的主 agent 过滤（子代理
 * invocation 不覆盖）、轮次状态机（工具计数优先于文字信号、begin/end
 * 复位）与 reset。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { turnStatusLabel } from "../../src/plugins/project/conversation/runtimeStatusStore.ts";

function chrysRuntime(
  runtime: Record<string, unknown>,
  sessionId = "s-1",
): AcpSessionEvent {
  return {
    type: "agent_runtime",
    sessionId,
    runtime: normalizeChrysRuntime(runtime),
  };
}

function chrysUsage(
  usage: Record<string, unknown>,
  sessionId = "s-1",
): AcpSessionEvent {
  return {
    type: "agent_usage",
    sessionId,
    usage: {
      ...usage,
      scope:
        typeof usage.usageSourceId === "string" &&
        usage.usageSourceId !== sessionId
          ? "subagent"
          : "session",
    },
  } as unknown as AcpSessionEvent;
}

function toolEvent(
  toolCallId: string,
  status: string | undefined,
): AcpSessionEvent {
  return {
    type: "tool_call_update",
    sessionId: "s-1",
    toolCallId,
    status,
  } as AcpSessionEvent;
}

beforeEach(() => {
  useRuntimeStatusStore.getState().reset();
});

it("does not restart a completed tool when late child details arrive", () => {
  const store = useRuntimeStatusStore.getState();
  store.handleSessionEvent(toolEvent("parent", "in_progress"));
  store.handleSessionEvent(toolEvent("parent", "completed"));
  store.handleSessionEvent(toolEvent("parent", undefined));
  expect(useRuntimeStatusStore.getState().runningToolCount).toBe(0);
});

it("uses adapter scope rather than interpreting another agent's source IDs", () => {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      scope: "session",
      usageSourceId: "provider-main-window",
      contextUsed: 20,
      maxContextTokens: 100,
      totalSessionTokens: 200,
    },
  });
  expect(useRuntimeStatusStore.getState().usage?.contextUsed).toBe(20);
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      scope: "subagent",
      contextUsed: 90,
      maxContextTokens: 1000,
      totalSessionTokens: 350,
    },
  });
  expect(useRuntimeStatusStore.getState().usage).toMatchObject({
    contextUsed: 20,
    maxContextTokens: 100,
    totalSessionTokens: 350,
  });
});

it("retains cumulative spend when the first usage report comes from a child", () => {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      scope: "subagent",
      contextUsed: 90,
      totalSessionTokens: 350,
    },
  });
  expect(useRuntimeStatusStore.getState().usage).toMatchObject({
    contextUsed: null,
    totalSessionTokens: 350,
  });
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "s",
    contextUsed: 20,
    contextSize: 100,
  });
  expect(useRuntimeStatusStore.getState().usage).toMatchObject({
    contextUsed: 20,
    totalSessionTokens: 350,
  });
});

describe("runtimeStatusStore", () => {
  it("runtime 完整快照落地，runtimeDetails 收窄出模型与 MCP/skill 来源", () => {
    useRuntimeStatusStore.getState().handleSessionEvent(
      chrysRuntime({
        agentProfile: "Code",
        displayName: "Code",
        modelProfileId: "glm-max",
        maxContextTokens: 128000,
        skillNames: ["aaw-workflow", "code-check"],
        toolNames: ["shell", "read_file"],
        runtimeDetails: {
          model: { name: "GLM-4.6", provider: "zhipu" },
          mcp_tools: {
            "server-b": ["tool1", "tool2"],
            "server-a": ["tool1"],
          },
          mcp_failures: { "server-c": "connection refused" },
          skill_sources: { user: ["aaw-workflow"], project: ["code-check"] },
        },
      }),
    );
    const runtime = useRuntimeStatusStore.getState().runtime;
    expect(runtime.modelProfileId).toBe("glm-max");
    expect(runtime.modelName).toBe("GLM-4.6");
    expect(runtime.modelProvider).toBe("zhipu");
    expect(runtime.skillNames).toEqual(["aaw-workflow", "code-check"]);
    // MCP 服务器按名排序；失败原因单列
    expect(runtime.mcpServers).toEqual([
      { name: "server-a", toolCount: 1 },
      { name: "server-b", toolCount: 2 },
    ]);
    expect(runtime.mcpFailures).toEqual([
      { name: "server-c", error: "connection refused" },
    ]);
    expect(runtime.skillSources).toEqual([
      { source: "project", count: 1 },
      { source: "user", count: 1 },
    ]);
  });

  it("partial 更新只覆盖出现过的字段（AgentRuntimeUpdated 形状）", () => {
    useRuntimeStatusStore.getState().handleSessionEvent(
      chrysRuntime({
        modelProfileId: "glm-max",
        maxContextTokens: 128000,
        skillNames: ["aaw-workflow"],
        runtimeDetails: {
          model: { name: "GLM-4.6", provider: "zhipu" },
          mcp_tools: { "server-a": ["tool1"] },
          skill_sources: { user: ["aaw-workflow"] },
        },
      }),
    );
    useRuntimeStatusStore.getState().handleSessionEvent(
      chrysRuntime({
        // partial：只换了模型，未带的字段保持旧值
        modelProfileId: "glm-air",
        runtimeDetails: {
          model: { name: "GLM-5-Air", provider: "zhipu" },
          mcp_tools: { "server-a": ["tool1"] },
          skill_sources: { user: ["aaw-workflow"] },
        },
      }),
    );
    const runtime = useRuntimeStatusStore.getState().runtime;
    expect(runtime.modelProfileId).toBe("glm-air");
    expect(runtime.modelName).toBe("GLM-5-Air");
    expect(runtime.maxContextTokens).toBe(128000);
    expect(runtime.skillNames).toEqual(["aaw-workflow"]);
  });

  it("runtimeDetails 缺失的 partial 不清空既有 MCP/skill 信息", () => {
    useRuntimeStatusStore.getState().handleSessionEvent(
      chrysRuntime({
        skillNames: ["aaw-workflow"],
        runtimeDetails: {
          mcp_tools: { "server-a": ["tool1"] },
          skill_sources: { user: ["aaw-workflow"] },
        },
      }),
    );
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(chrysRuntime({ modelProfileId: "glm-max" }));
    const runtime = useRuntimeStatusStore.getState().runtime;
    expect(runtime.mcpServers).toEqual([{ name: "server-a", toolCount: 1 }]);
    expect(runtime.skillNames).toEqual(["aaw-workflow"]);
  });

  it("usage：主 agent（usageSourceId=sessionId 或缺失）落地，子代理不覆盖", () => {
    useRuntimeStatusStore.getState().handleSessionEvent(
      chrysUsage({
        sessionId: "s-1",
        pct: 42.5,
        totalTokens: 51000,
        maxContextTokens: 120000,
        totalSessionTokens: 90000,
        cacheHitTokens: 8000,
        usageSourceId: "s-1",
      }),
    );
    expect(useRuntimeStatusStore.getState().usage).toMatchObject({
      pct: 42.5,
      totalTokens: 51000,
      totalSessionTokens: 90000,
    });
    // 子代理 invocation 用量（usageSourceId ≠ sessionId）：忽略
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(
        chrysUsage({ pct: 99, usageSourceId: "invocation-7" }),
      );
    expect(useRuntimeStatusStore.getState().usage?.pct).toBe(42.5);
  });

  it("轮次状态机：工具计数优先；thought/message 切换文字信号；endTurn 复位", () => {
    const store = useRuntimeStatusStore.getState();
    store.beginTurn();
    expect(useRuntimeStatusStore.getState().isTurnActive).toBe(true);
    expect(turnStatusLabel(useRuntimeStatusStore.getState())).toBe("思考中");

    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "agent_thought_chunk",
      sessionId: "s-1",
      text: "推理中",
    });
    expect(turnStatusLabel(useRuntimeStatusStore.getState())).toBe("思考中");

    // 工具开跑：计数优先于文字信号
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(toolEvent("t1", "in_progress"));
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(toolEvent("t2", "in_progress"));
    expect(turnStatusLabel(useRuntimeStatusStore.getState())).toBe(
      "工具运行中 2",
    );

    // 工具终态移出计数；message chunk 后转「生成中」
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(toolEvent("t1", "completed"));
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(toolEvent("t2", "failed"));
    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "agent_message_chunk",
      sessionId: "s-1",
      text: "答案",
    });
    expect(turnStatusLabel(useRuntimeStatusStore.getState())).toBe("生成中");

    useRuntimeStatusStore.getState().endTurn();
    const state = useRuntimeStatusStore.getState();
    expect(state.isTurnActive).toBe(false);
    expect(state.runningToolCount).toBe(0);
    expect(state.lastSignal).toBeNull();
  });

  it("标准上下文优先，ICode 仅补充明细", () => {
    const store = useRuntimeStatusStore.getState();
    // 标准版先到：pct 按占用比折算，token 明细为空
    store.handleSessionEvent({
      type: "usage_update",
      sessionId: "s-1",
      contextSize: 1_000_000,
      contextUsed: 250_000,
    });
    expect(useRuntimeStatusStore.getState().usage).toMatchObject({
      pct: 25,
      maxContextTokens: 1_000_000,
      contextUsed: 250_000,
      totalSessionTokens: null,
      inputTokens: null,
    });
    expect(useRuntimeStatusStore.getState().usageSource).toBe("standard");

    // ICode 仅补充明细，不覆盖标准占用
    store.handleSessionEvent(
      chrysUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    );
    expect(useRuntimeStatusStore.getState().usage).toMatchObject({
      inputTokens: 10,
    });
    expect(useRuntimeStatusStore.getState().usageSource).toBe("standard");

    // 标准版再来：更新占用，保留扩展明细
    store.handleSessionEvent({
      type: "usage_update",
      sessionId: "s-1",
      contextSize: 500_000,
      contextUsed: 100_000,
    });
    expect(useRuntimeStatusStore.getState().usage).toMatchObject({
      inputTokens: 10,
    });
    expect(useRuntimeStatusStore.getState().usageSource).toBe("standard");
  });

  it("available_commands 落地为命令清单快照，reset 清空", () => {
    useRuntimeStatusStore.getState().handleSessionEvent({
      type: "available_commands",
      sessionId: "s-1",
      commands: [
        { name: "review", description: "审查当前改动", inputHint: "可选说明" },
        { name: "plan", description: null, inputHint: null },
      ],
    });
    expect(useRuntimeStatusStore.getState().availableCommands).toHaveLength(2);
    expect(useRuntimeStatusStore.getState().availableCommands[0]).toMatchObject(
      {
        name: "review",
      },
    );
    useRuntimeStatusStore.getState().reset();
    expect(useRuntimeStatusStore.getState().availableCommands).toHaveLength(0);
  });

  it("reset 清空 runtime/usage/轮次（会话切换语义）", () => {
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(chrysRuntime({ modelProfileId: "glm-max" }));
    useRuntimeStatusStore.getState().beginTurn();
    useRuntimeStatusStore
      .getState()
      .handleSessionEvent(toolEvent("t1", "in_progress"));

    useRuntimeStatusStore.getState().reset();
    const state = useRuntimeStatusStore.getState();
    expect(state.runtime.modelProfileId).toBeNull();
    expect(state.usage).toBeNull();
    expect(state.isTurnActive).toBe(false);
    expect(state.runningToolCount).toBe(0);
  });
});

it("does not reuse cumulative 10M as occupancy of a 200k window", () => {
  useRuntimeStatusStore.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      totalSessionTokens: 10_000_000,
      maxContextTokens: 200_000,
    },
  });
  expect(useRuntimeStatusStore.getState().usage?.contextUsed).toBeNull();
  expect(useRuntimeStatusStore.getState().usage?.totalSessionTokens).toBe(
    10_000_000,
  );
});

it("does not infer context from call totals and preserves call totals across standard updates", () => {
  const store = useRuntimeStatusStore.getState();
  store.handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: { sessionId: "s", totalTokens: 120, totalSessionTokens: 9000 },
  });
  expect(useRuntimeStatusStore.getState().usage?.contextUsed).toBeNull();
  store.handleSessionEvent({
    type: "usage_update",
    sessionId: "s",
    contextUsed: 8000,
    contextSize: 32000,
  });
  expect(useRuntimeStatusStore.getState().usage).toMatchObject({
    contextUsed: 8000,
    pct: 25,
    totalTokens: 120,
    totalSessionTokens: 9000,
  });
  store.handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      totalTokens: 150,
      contextUsed: 150,
      sourceLabel: "estimated",
    },
  });
  expect(useRuntimeStatusStore.getState().usage).toMatchObject({
    contextUsed: 8000,
    pct: 25,
    totalTokens: 150,
    sourceLabel: "标准 ACP 上下文",
  });
});
