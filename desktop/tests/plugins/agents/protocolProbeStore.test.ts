/**
 * src/stores/protocolProbeStore 测试：探查状态机流转（idle → probing →
 * done）与结果持有。探查执行本身在 tests/plugins/agents/agentProbe.test.ts。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createProtocolProbeStore } from "../../../src/plugins/agents/probe/protocolProbeStore.ts";
import type { AgentProbeResult } from "../../../src/plugins/agents/types.ts";

const fakeResult = (): AgentProbeResult => ({
  agentId: "chrys",
  agentLabel: "iCode",
  depth: "safe",
  startedAt: "2026-01-01T00:00:00.000Z",
  elapsedMs: 12,
  ok: true,
  failedStep: null,
  failureReason: null,
  protocolVersion: 1,
  agentName: "chrys",
  agentVersion: "0.30.0",
  capabilities: {},
  models: null,
  modes: null,
  list: { status: "ok", count: 0 },
  closeAck: true,
  events: { eventTypeCounts: {}, toolKindCounts: {}, rawMethodCounts: {} },
  permissionRequests: 0,
  questionRequests: 0,
  prompts: [],
});

const probeStore = createProtocolProbeStore();

describe("protocolProbeStore", () => {
  beforeEach(() => {
    probeStore.getState().reset();
  });

  it("初始为 idle 且无结果；begin 进入 probing 并带起步步骤", () => {
    expect(probeStore.getState().phase).toBe("idle");
    probeStore.getState().begin("chrys");
    const state = probeStore.getState();
    expect(state.phase).toBe("probing");
    expect(state.step).toBe("启动进程");
    expect(state.probingAgentId).toBe("chrys");
    expect(state.result).toBeNull();
    expect(state.resultsByAgent).toEqual({});
  });

  it("setStep 更新进度；finish 落结果并按 agent 记忆结论；reset 全清", () => {
    const store = probeStore.getState();
    store.begin("chrys");
    probeStore.getState().setStep("握手 initialize");
    expect(probeStore.getState().step).toBe("握手 initialize");

    const result = fakeResult();
    probeStore.getState().finish(result);
    const done = probeStore.getState();
    expect(done.phase).toBe("done");
    expect(done.step).toBeNull();
    expect(done.probingAgentId).toBeNull();
    expect(done.result).toBe(result);
    // 按 agentId 记忆：列表行摘要的数据源
    expect(done.resultsByAgent["chrys"]).toBe(result);

    done.reset();
    const cleared = probeStore.getState();
    expect(cleared.phase).toBe("idle");
    expect(cleared.result).toBeNull();
    expect(cleared.resultsByAgent).toEqual({});
  });

  it("取消当前探查时保留该 Agent 上一次的报告", () => {
    const actions = probeStore.getState();
    const previous = fakeResult();
    actions.begin(previous.agentId);
    actions.finish(previous);
    actions.begin(previous.agentId);
    actions.cancel();

    expect(probeStore.getState()).toMatchObject({
      phase: "idle",
      step: null,
      probingAgentId: null,
      result: null,
      resultsByAgent: { chrys: previous },
    });
  });
});
