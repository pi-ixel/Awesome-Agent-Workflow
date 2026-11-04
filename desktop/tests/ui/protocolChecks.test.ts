/**
 * src/ui/protocolChecks 测试：检查表按「能力」组织、与 agent 底座无关——
 * 同一能力可有多种提供形式（如用量显示：标准 usage_update 或 iCode 扩展），
 * 任一已消费形式满足即「支持」。两份画像快照对照：
 * - iCode 画像：扩展形式全满足（用量经扩展、运行时信息、结构化问答）；
 * - OpenCode 画像（据 2026-10 实测）：标准用量与命令清单在客户端接入后
 *   直接「支持」；仅扩展形式的增强能力「缺失」。
 * 推导的行语义变了，这里必须跟着变——这是底座差异的活文档。
 */
import { describe, expect, it } from "vitest";
import {
  deriveProtocolChecks,
  probeSummary,
} from "../../src/ui/protocolChecks";
import type { AgentProbeResult } from "../../src/stores/protocolProbeStore";

function findRow(
  groups: readonly ReturnType<typeof deriveProtocolChecks>[number][],
  key: string,
) {
  for (const group of groups) {
    const row = group.rows.find((item) => item.key === key);
    if (row !== undefined) return row;
  }
  throw new Error(`检查表里没有能力行：${key}`);
}

const base = {
  startedAt: "2026-01-01T00:00:00.000Z",
  elapsedMs: 1500,
  permissionRequests: 0,
  questionRequests: 0,
  list: { status: "ok", count: 1 } as const,
  closeAck: true,
};

/** iCode 画像（据 echo-agent 真实行为）。 */
const iCodeProfile: AgentProbeResult = {
  ...base,
  agentId: "chrys",
  agentLabel: "iCode",
  depth: "deep",
  ok: true,
  failedStep: null,
  failureReason: null,
  protocolVersion: 1,
  agentName: "chrys",
  agentVersion: "0.30.0",
  capabilities: {
    loadSession: true,
    promptCapabilities: { embeddedContext: true, image: false },
    mcpCapabilities: { http: true, sse: false },
    sessionCapabilities: { close: {}, list: {} },
  },
  models: {
    currentModelId: "glm-x",
    availableModels: [{ modelId: "glm-x", name: "GLM X" }],
  },
  modes: {
    currentModeId: "auto",
    availableModes: [{ id: "auto", name: "Auto" }],
  },
  events: {
    eventTypeCounts: {
      agent_message_chunk: 6,
      agent_thought_chunk: 3,
      tool_call: 2,
      tool_call_update: 2,
      plan: 1,
      agent_runtime: 1,
      agent_usage: 2,
      available_commands: 1,
    },
    toolKindCounts: { read: 1, execute: 1 },
    rawMethodCounts: {},
  },
  permissionRequests: 1,
  questionRequests: 1,
  prompts: [
    { status: "ok", stopReason: "end_turn" },
    { status: "ok", stopReason: "end_turn" },
  ],
};

/** OpenCode 画像（据 2026-10 本机实测）。 */
const openCodeProfile: AgentProbeResult = {
  ...base,
  agentId: "native-opencode",
  agentLabel: "OpenCode",
  depth: "deep",
  ok: true,
  failedStep: null,
  failureReason: null,
  protocolVersion: 1,
  agentName: "OpenCode",
  agentVersion: "1.19.5",
  capabilities: {
    loadSession: true,
    promptCapabilities: { embeddedContext: true, image: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
  },
  models: null,
  modes: null,
  events: {
    eventTypeCounts: {
      agent_message_chunk: 5,
      agent_thought_chunk: 8,
      tool_call: 1,
      tool_call_update: 2,
      usage_update: 2,
      available_commands: 1,
    },
    toolKindCounts: { read: 1 },
    rawMethodCounts: { "session/update:available_commands_update": 1 },
  },
  prompts: [
    { status: "ok", stopReason: "end_turn" },
    { status: "ok", stopReason: "end_turn" },
  ],
};

describe("deriveProtocolChecks（能力视角的底座差异对照）", () => {
  it("iCode 画像：核心对话全绿；用量经扩展满足；增强能力在位", () => {
    const groups = deriveProtocolChecks(iCodeProfile);
    expect(findRow(groups, "link").status).toBe("ok");
    // 对话核心
    for (const key of ["messages", "thoughts", "tools", "plan", "approval"]) {
      expect(findRow(groups, key).status).toBe("ok");
    }
    // 工具 kind 分布进注脚
    expect(findRow(groups, "tools").detail).toContain("read");
    // 用量：扩展形式已消费 → 支持，注明形式
    const usage = findRow(groups, "usage");
    expect(usage.status).toBe("ok");
    expect(usage.detail).toContain("iCode 扩展");
    // 增强能力经扩展满足
    expect(findRow(groups, "runtime-info").status).toBe("ok");
    expect(findRow(groups, "questions").status).toBe("ok");
    // 命令清单：裸风格通知 → 已接入，支持
    const commands = findRow(groups, "commands");
    expect(commands.status).toBe("ok");
    // 会话管理与输入控制
    expect(findRow(groups, "restore").status).toBe("ok");
    expect(findRow(groups, "model-switch").status).toBe("ok");
    expect(findRow(groups, "mode-switch").status).toBe("ok");
  });

  it("OpenCode 画像：用量走了标准形式但客户端未接入（适配点）；仅扩展形式的增强能力标缺失", () => {
    const groups = deriveProtocolChecks(openCodeProfile);

    // 用量显示：客户端已接入标准 usage_update → OpenCode 上直接支持
    const usage = findRow(groups, "usage");
    expect(usage.status).toBe("ok");
    expect(usage.detail).toContain("标准 usage_update");

    // 模型 / 模式：agent 未下发清单 → 缺失 + 降级影响
    expect(findRow(groups, "model-switch").impact).toContain("切换器");
    expect(findRow(groups, "mode-switch").status).toBe("info");

    // 仅 iCode 扩展能提供的增强：深度探查后标缺失（证据注明「当前仅经扩展」）
    const runtime = findRow(groups, "runtime-info");
    expect(runtime.status).toBe("info");
    expect(runtime.badge).toBe("可选增强未观测");
    expect(runtime.detail).toContain("仅经");
    expect(findRow(groups, "questions").status).toBe("info");

    // 命令清单：翻译层已归一命名空间风格 → 支持
    expect(findRow(groups, "commands").status).toBe("ok");
  });

  it("安全探查下对话类能力统一「待验证」，不挂吓人的影响文案；深度探查行不渲染", () => {
    const safe = deriveProtocolChecks({
      ...iCodeProfile,
      depth: "safe",
      events: {
        eventTypeCounts: { agent_runtime: 1 },
        toolKindCounts: {},
        rawMethodCounts: {},
      },
      permissionRequests: 0,
      questionRequests: 0,
      prompts: [],
    });
    const messages = findRow(safe, "messages");
    expect(messages.status).toBe("unobserved");
    expect(messages.badge).toBe("待验证");
    expect(messages.impact).toBe("");
    const hasPromptRow = safe.some((group) =>
      group.rows.some((row) => row.key === "prompt-turn"),
    );
    expect(hasPromptRow).toBe(false);
  });

  it("深度对话轮全败（模型超时/无凭证）：事件类能力保持「待验证」，不下缺失结论", () => {
    const groups = deriveProtocolChecks({
      ...openCodeProfile,
      prompts: [
        { status: "failed", stopReason: null, reason: "AcpTimeoutError: 90s" },
        { status: "failed", stopReason: null, reason: "AcpTimeoutError: 120s" },
      ],
      // 对话没发生：事件流里只剩 session/new 后的早期通知
      events: {
        eventTypeCounts: { available_commands: 1 },
        toolKindCounts: {},
        rawMethodCounts: {},
      },
    });
    const messages = findRow(groups, "messages");
    expect(messages.status).toBe("unobserved");
    expect(messages.badge).toBe("待验证");
    expect(messages.detail).toContain("对话轮未成功");
    expect(messages.impact).toBe("");
    // 对话深度行如实给出两轮失败原因
    const turn = findRow(groups, "prompt-turn");
    expect(turn.status).toBe("danger");
    expect(turn.detail).toContain("AcpTimeoutError");
    // 早期通知类能力不受影响（不依赖对话）
    expect(findRow(groups, "commands").status).toBe("ok");
  });

  it("链路失败：握手组出现 danger 行，会话管理如实缺失", () => {
    const groups = deriveProtocolChecks({
      ...iCodeProfile,
      ok: false,
      failedStep: "连接链路",
      failureReason: "AcpHandshakeError: 协议版本协商失败",
      protocolVersion: null,
      agentName: null,
      capabilities: null,
      list: null,
    });
    const link = findRow(groups, "link");
    expect(link.status).toBe("danger");
    expect(link.detail).toContain("协议版本协商失败");
    expect(findRow(groups, "history").status).not.toBe("ok");
  });

  it("probeSummary 统计各状态行数", () => {
    const summary = probeSummary(deriveProtocolChecks(iCodeProfile));
    expect(summary.ok).toBeGreaterThan(5);
    expect(summary.danger).toBe(0);
  });
});

it("lists unsupported optional session history as information rather than a broken core protocol", () => {
  const groups = deriveProtocolChecks({
    ...iCodeProfile,
    list: { status: "unsupported", count: null },
  });
  expect(findRow(groups, "history").status).toBe("info");
  expect(findRow(groups, "history").badge).toBe("可选能力未提供");
});
