/**
 * 原生会话宿主的 spawn_node_session（批次一 §7 接线回归）：
 * - MCP 清单 = 需求单 `mcp_servers` 标准元素 + 结果通道；结果通道按 Agent
 *   initialize 声明的 mcpCapabilities 选定 stdio/HTTP（ADR 024 §9-3），
 *   session/new 与 session/load 同一规则；
 * - profile 非空的新会话执行 `_session/switch_agent` 扩展请求并核验
 *   `toProfile` 回执（ADR 024 §7 改动 2；旧线原实现语义）。
 *
 * 线路用真实装配：JsonRpcConnection（in-memory transport 对端脚本化
 * agent）+ 共享 AcpSession——与 index.ts createNodeChannelFactory 同构。
 */
import { describe, expect, it } from "vitest";
import { createTransportPair } from "../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { JsonRpcConnection } from "../../../src/plugins/acpConnection/service.ts";
import { AcpSession } from "../../../src/plugins/acpRuntime/service.ts";
import { createLogger } from "../../../src/shared/logging/logger.ts";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import type { SpawnRequirementWire } from "../../../src/plugins/workflow/engine/protocol.ts";
import { NativeBridgeHub } from "../../../src/plugins/workflow/sessionHost/nativeBridge.ts";
import {
  attachNativeSessionHost,
} from "../../../src/plugins/workflow/sessionHost/nativeSessionHost.ts";

type SeenRequest = { method: string; params: Record<string, unknown> };

/** 仿真 agent 的脚本：switch_agent 回执、是否声明 HTTP MCP 能力。 */
type AgentScript = { toProfile?: unknown; httpMcp?: boolean; loadSession?: boolean; models?: readonly string[] };

/** 仿真 agent：initialize / session/new 应答 + 可选的 switch_agent 回执；
 * 收到的请求按序记入 seen（断言 wire 形状用）。 */
function scriptedAgent(
  peer: ReturnType<typeof createTransportPair>["peer"],
  seen: SeenRequest[],
  script: AgentScript = {},
): void {
  peer.onLine((line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.method === undefined || message.id === undefined) return;
    seen.push({ method: message.method, params: message.params ?? {} });
    const reply = (result: unknown) =>
      peer.writeLine(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      );
    switch (message.method) {
      case "initialize":
        reply({
          protocolVersion: 1,
          agentInfo: { name: "echo-agent", version: "1" },
          agentCapabilities: {
            loadSession: script.loadSession ?? true,
            ...(script.httpMcp === undefined ? {} : { mcpCapabilities: { http: script.httpMcp } }),
          },
        });
        break;
      case "session/new":
        reply(script.models === undefined ? { sessionId: "sess-1" } : {
          sessionId: "sess-1",
          models: { currentModelId: script.models[0], availableModels: script.models.map((modelId) => ({ modelId, name: modelId })) },
        });
        break;
      case "session/set_model":
        reply({});
        break;
      case "session/load":
        reply({});
        break;
      case "session/prompt":
        peer.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "请确认" } } } }));
        reply({ stopReason: "end_turn" });
        break;
      case "_session/switch_agent":
        reply(script.toProfile === undefined ? {} : { toProfile: script.toProfile });
        break;
      default:
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "method not found" },
          }),
        );
    }
  });
}

/** 需求单信封（session_host.rs SessionRequirement 的最小线形状）。 */
function requirement(
  overrides: Partial<SpawnRequirementWire> = {},
): SpawnRequirementWire {
  return {
    action: { site: "design", ordinal: 1, actor: "designer", input: {} },
    cwd: "D:/work",
    command: ["agent", "--acp"],
    profile: null,
    mcp_servers: [],
    resume_session_id: null,
    ...overrides,
  };
}

interface Harness {
  spawn(requirement: SpawnRequirementWire): Promise<{ result: unknown; code?: string }>;
  prompt(action: SpawnRequirementWire["action"]): Promise<void>;
  projected: WorkflowEvent[];
  seen: SeenRequest[];
  dispose(): void;
}

/** 装配一个挂着脚本化 agent 的原生宿主；spawn 驱动一条 spawn_node_session
 * 帧并等待同 id 应答帧。收养路径用真实装配：openAgentsSession 走
 * JsonRpcConnection + 共享 AcpSession（脚本化 agent 直连），adoptSession
 * 直接登记 create 返回的句柄（project 收养语义的最小替身）。 */
function makeHarness(script: AgentScript = {}): Harness {
  const seen: SeenRequest[] = [];
  let deliver: ((event: WorkflowEvent) => void) | null = null;
  const responses: Array<{ id: number; response: Record<string, unknown> }> = [];
  const projected: WorkflowEvent[] = [];
  const bridge = new NativeBridgeHub();
  bridge.registerWorkflowEventProjector((event) => projected.push(event));
  const detach = attachNativeSessionHost(
    {
      workflow: {
        subscribe: (observer) => {
          deliver = observer;
          return () => {
            deliver = null;
          };
        },
        respondHostFrame: async (_runId, frame) => {
          await Promise.resolve();
          responses.push(JSON.parse(frame) as { id: number; response: Record<string, unknown> });
        },
      },
      bridge,
      adoptSession: async (options) => {
        const port = await options.create({
          background: false,
          onElicitation: () => Promise.resolve({ action: "cancel" }),
          onQuestion: () => Promise.resolve(null),
          onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
        }, { agentKey: "agent@test" });
        return { sessionId: port.sessionId ?? "" };
      },
      openAgentsSession: ({ sessionOptions, clientInfo, dialect }) => {
        const { client, peer } = createTransportPair();
        scriptedAgent(peer, seen, script);
        const connection = new JsonRpcConnection(client, {});
        void clientInfo;
        return new AcpSession(
          connection,
          { ...sessionOptions, dialect } as never,
          () => {},
        );
      },
      releaseAgentsSession: async () => {},
    },
    {},
    true,
    { logger: createLogger("workflow-native-host-test") },
  );
  return {
    async spawn(next) {
      const before = responses.length;
      deliver!({
        type: "host-frame",
        runId: "run-1",
        frame: JSON.stringify({
          id: 7,
          request: { kind: "spawn_node_session", requirement: next },
        }),
      });
      const deadline = Date.now() + 2_000;
      while (responses.length === before) {
        if (Date.now() > deadline) throw new Error("spawn_node_session 应答超时");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { result: responses[before]!.response.result, code: responses[before]!.response.code as string | undefined };
    },
    async prompt(action) {
      const before = responses.length;
      deliver!({ type: "host-frame", runId: "run-1", frame: JSON.stringify({ id: 8, request: { kind: "prompt_turn", session_id: "sess-1", action, prompt: "继续" } }) });
      const deadline = Date.now() + 2_000;
      while (responses.length === before) {
        if (Date.now() > deadline) throw new Error("prompt_turn 应答超时");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (responses[before]!.response.code) throw new Error(JSON.stringify(responses[before]!.response.code));
    },
    projected,
    seen,
    dispose: detach,
  };
}

describe("nativeSessionHost spawn_node_session", () => {
  it("attributes a reused session's messages to the current action", async () => {
    const harness = makeHarness();
    try {
      await harness.spawn(requirement());
      await harness.prompt({ site: "repair", ordinal: 2, actor: "designer", input: {} });
      const message = harness.projected.find((event) => event.type === "acp-event" && (event.event as { type?: string })?.type === "agent_message_chunk");
      expect(message?.instance).toMatchObject({ siteId: "repair", ordinal: 2 });
    } finally {
      harness.dispose();
    }
  });
  const offer = {
    name: "aaw-workflow-result",
    stdio: {
      command: "C:/aaw/workflow_service.exe",
      args: ["--result-mcp", "127.0.0.1:50123"],
      env: [{ name: "AAW_RESULT_TOKEN", value: "secret" }],
    },
    http: {
      url: "http://127.0.0.1:50123/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    },
  };
  const stdioElement = {
    name: "aaw-workflow-result",
    command: "C:/aaw/workflow_service.exe",
    args: ["--result-mcp", "127.0.0.1:50123"],
    env: [{ name: "AAW_RESULT_TOKEN", value: "secret" }],
  };
  const httpElement = {
    type: "http",
    name: "aaw-workflow-result",
    url: "http://127.0.0.1:50123/mcp",
    headers: [{ name: "Authorization", value: "Bearer secret" }],
  };
  const mcpOf = (harness: Harness, method: string) =>
    harness.seen.find((item) => item.method === method)?.params.mcpServers;

  it("调用方 mcp_servers：标准元素原样下发，非标准项丢弃", async () => {
    const harness = makeHarness();
    try {
      const http = { type: "http", name: "knowledge", url: "http://127.0.0.1:9876/mcp", headers: [] };
      const stdio = { name: "local", command: "tool.exe", args: [], env: [] };
      const outcome = await harness.spawn(
        requirement({
          mcp_servers: [http, stdio, "junk", 42, { name: "typed", type: "stdio", command: "x" }],
        }),
      );
      expect(outcome.code).toBeUndefined();
      expect(outcome.result).toEqual({ sessionId: "sess-1" });
      expect(mcpOf(harness, "session/new")).toEqual([http, stdio]);
    } finally {
      harness.dispose();
    }
  });

  it("无 mcp_servers、无结果通道时按 [] 下发（与底座默认逐字节一致）", async () => {
    const harness = makeHarness();
    try {
      await harness.spawn(requirement());
      expect(mcpOf(harness, "session/new")).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("Agent 未声明 http：结果通道以标准 stdio 元素下发（无 type、令牌在 env）", async () => {
    const harness = makeHarness();
    try {
      const outcome = await harness.spawn(requirement({ result_channel: offer }));
      expect(outcome.code).toBeUndefined();
      expect(mcpOf(harness, "session/new")).toEqual([stdioElement]);
    } finally {
      harness.dispose();
    }
  });

  it("Agent 声明 http：结果通道以 HTTP 元素下发，追加在调用方清单之后", async () => {
    const harness = makeHarness({ httpMcp: true });
    try {
      const caller = { name: "local", command: "tool.exe", args: [], env: [] };
      await harness.spawn(requirement({ mcp_servers: [caller], result_channel: offer }));
      expect(mcpOf(harness, "session/new")).toEqual([caller, httpElement]);
    } finally {
      harness.dispose();
    }
  });

  it("Agent 显式声明 http: false：仍走 stdio", async () => {
    const harness = makeHarness({ httpMcp: false });
    try {
      await harness.spawn(requirement({ result_channel: offer }));
      expect(mcpOf(harness, "session/new")).toEqual([stdioElement]);
    } finally {
      harness.dispose();
    }
  });

  it("恢复会话：session/load 按同一规则携带结果通道", async () => {
    const harness = makeHarness({ httpMcp: true });
    try {
      const outcome = await harness.spawn(
        requirement({ result_channel: offer, resume_session_id: "sess-saved" }),
      );
      expect(outcome.code).toBeUndefined();
      expect(mcpOf(harness, "session/load")).toEqual([httpElement]);
      expect(harness.seen.some((item) => item.method === "session/new")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("Agent 未声明恢复能力时给出明确错误，不发送 session/load", async () => {
    const harness = makeHarness({ loadSession: false });
    try {
      const outcome = await harness.spawn(requirement({ resume_session_id: "sess-saved" }));
      expect(outcome.code).toBe("WORKFLOW_AGENT_RESUME_UNSUPPORTED");
      expect(harness.seen.some((item) => item.method === "session/load")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("结果通道提供形状不全 → RESULT_CHANNEL_OFFER_INVALID，不拉起会话", async () => {
    const harness = makeHarness();
    try {
      const outcome = await harness.spawn(
        requirement({ result_channel: { name: "aaw-workflow-result" } as never }),
      );
      expect(outcome.code).toBe("RESULT_CHANNEL_OFFER_INVALID");
      expect(harness.seen.some((item) => item.method === "session/new")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("profile 非空：_session/switch_agent 携带 agentProfile 与 sessionId；toProfile 回执确认", async () => {
    const harness = makeHarness({ toProfile: "coder" });
    try {
      const outcome = await harness.spawn(requirement({ profile: "coder" }));
      expect(outcome.code).toBeUndefined();
      const extension = harness.seen.find(
        (item) => item.method === "_session/switch_agent",
      );
      expect(extension?.params).toEqual({ agentProfile: "coder", sessionId: "sess-1" });
    } finally {
      harness.dispose();
    }
  });

  it("按角色指定的模型：新会话经 session/set_model 设置；Agent 没有这个模型时如实失败", async () => {
  const harness = makeHarness({ models: ["slow", "fast"] });
  try {
    const outcome = await harness.spawn(requirement({ model: "fast" }));
    expect(outcome.code).toBeUndefined();
    expect(harness.seen.find((item) => item.method === "session/set_model")?.params).toEqual({ sessionId: "sess-1", modelId: "fast" });
  } finally {
    harness.dispose();
  }
  const missing = makeHarness({ models: ["slow"] });
  try {
    const outcome = await missing.spawn(requirement({ model: "fast" }));
    expect(outcome.code).toBe("WORKFLOW_MODEL_UNAVAILABLE:fast");
    expect(missing.seen.some((item) => item.method === "session/set_model")).toBe(false);
  } finally {
    missing.dispose();
  }
});
it("switch_agent 回执缺 toProfile → 如实报 ACP_PROFILE_SWITCH_UNCONFIRMED", async () => {
    const harness = makeHarness({});
    try {
      const outcome = await harness.spawn(requirement({ profile: "coder" }));
      expect(outcome.code).toBe("ACP_PROFILE_SWITCH_UNCONFIRMED");
    } finally {
      harness.dispose();
    }
  });
});
