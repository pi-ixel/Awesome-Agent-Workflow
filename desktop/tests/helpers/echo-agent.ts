/**
 * 进程内仿真 agent（echo-agent）：讲与 chrys 相同的 ACP 方言，供
 * 单测在无 chrys 环境下驱动完整协议通路（tests/acp/* 的测试替身）。
 *
 * 实现（对照 chrys server.py 的行为）：
 * - `initialize`：回 `min(请求版本, 支持版本)`（可注入配置以测试协商失败）；
 * - `session/new | load | list`：真实分配/登记会话，回 modes + models；
 * - `session/prompt`：按脚本派发 `session/update` 通知流（消息 chunk、
 *   工具调用、计划、用量、chrys 扩展），可选发起反向请求
 *   （`session/request_permission` / `_chrys/request_input`），最后回
 *   stopReason；收到 `session/cancel` 通知后回 `cancelled`；
 * - `session/set_mode | set_model | close`：空响应 + 相应通知。
 *
 * 用法：`const agent = new EchoAgent(); agent.attach(peer)`——peer 即
 * `createTransportPair()` 的对端。
 */

import type { InMemoryPeer } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";

/** 一轮 prompt 的可编程脚本。 */
export interface EchoTurnScript {
  /**
   * 派发通知前先发起的反向请求（客户端答复由注入的回调决定，
   * 记录在 receivedRequests 里供断言）。缺省不发起。
   */
  readonly reverseRequest?:
    { readonly kind: "permission" } | { readonly kind: "question" };
  /** 通知序列（session/update 的 update 对象或 chrys 扩展通知）。 */
  readonly updates?: readonly EchoUpdate[];
  /** 每条通知之间的延时（毫秒），缺省 0。 */
  readonly interDelayMs?: number;
  /** 最终 stopReason，缺省 "end_turn"。 */
  readonly stopReason?: "end_turn" | "cancelled" | "refusal" | "max_tokens";
  /** 回放用量。 */
  readonly usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** 收到取消通知前是否挂起不结束（配合测试 cancel）。 */
  readonly hangUntilCancelled?: boolean;
}

/** 一条待派发的通知：标准 session/update 或 chrys 扩展。 */
export type EchoUpdate =
  | { readonly sessionUpdate: string; readonly [key: string]: unknown }
  | {
      readonly chrysMethod: string;
      readonly params: Readonly<Record<string, unknown>>;
    };

export interface EchoAgentOptions {
  /** 服务端声明的协议版本（initialize 回 min(请求, 此值)）。 */
  readonly protocolVersion?: number;
  /** agentInfo 返回值。 */
  readonly agentInfo?: { readonly name: string; readonly version?: string };
  /** 会话建立时上报的模型状态。 */
  readonly models?: {
    readonly currentModelId: string | null;
    readonly availableModels: readonly { modelId: string; name: string }[];
  };
  /**
   * 缺省轮次脚本：未显式 script() 时每轮 prompt 都回放它
   * （显式 script() 优先且一次性）。
   */
  readonly defaultTurnScript?: EchoTurnScript;
}

interface ClientRequest {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
}

interface TrackedSession {
  sessionId: string;
  cwd: string;
  cancelled: boolean;
  /** 当前挂起轮次的唤醒回调（hangUntilCancelled 用）。 */
  cancelWaiter: (() => void) | null;
}

export class EchoAgent {
  private readonly options: Required<
    Pick<EchoAgentOptions, "protocolVersion">
  > &
    EchoAgentOptions;
  private peer: InMemoryPeer | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private sessionCounter = 0;
  /** 下一轮 prompt 使用的脚本；prompt 后自动清空（一次性）。 */
  private nextScript: EchoTurnScript | null = null;
  /** 收到的请求/通知记录（测试断言用）。 */
  readonly receivedRequests: {
    method: string;
    params: Readonly<Record<string, unknown>>;
  }[] = [];
  readonly receivedNotifications: {
    method: string;
    params: Readonly<Record<string, unknown>>;
  }[] = [];

  constructor(options: EchoAgentOptions = {}) {
    this.options = {
      protocolVersion: options.protocolVersion ?? 1,
      ...options,
    };
  }

  /** 挂到传输对端：接管对端行流（client→agent 请求/通知/响应都在这进）。 */
  attach(peer: InMemoryPeer): void {
    this.peer = peer;
    peer.onLine((line) => this.handleLine(line));
  }

  /** 设置下一轮 prompt 的脚本。 */
  script(turn: EchoTurnScript): void {
    this.nextScript = turn;
  }

  /** 处理一行 client→agent 消息：请求 / 通知 / 对反向请求的响应。 */
  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = parsed as ClientRequest;
    if (typeof message.method === "string") {
      const params =
        typeof message.params === "object" && message.params !== null
          ? message.params
          : {};
      if (message.id === undefined) {
        this.receivedNotifications.push({ method: message.method, params });
        this.handleNotification(message.method, params);
        return;
      }
      this.receivedRequests.push({ method: message.method, params });
      void this.handleRequest(message.id, message.method, params);
      return;
    }
    // client 对 agent 反向请求的响应
    if (typeof message.id === "number") {
      const waiter = this.pendingServerRequests.get(message.id);
      if (waiter !== undefined) {
        this.pendingServerRequests.delete(message.id);
        const result =
          typeof message.result === "object" && message.result !== null
            ? (message.result as Readonly<Record<string, unknown>>)
            : {};
        waiter(result);
      }
    }
  }

  // ----------------------------------------------------------------- 请求

  private async handleRequest(
    id: number | string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const result = await this.dispatch(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private modelsPayload(): Readonly<Record<string, unknown>> {
    return (
      this.options.models ?? {
        currentModelId: "echo-model",
        availableModels: [{ modelId: "echo-model", name: "Echo Model" }],
      }
    );
  }

  private async dispatch(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: Math.min(
            typeof params.protocolVersion === "number"
              ? params.protocolVersion
              : 1,
            this.options.protocolVersion,
          ),
          agentInfo: this.options.agentInfo ?? {
            name: "echo-agent",
            version: "0.1.0",
          },
          agentCapabilities: {
            auth: null,
            loadSession: true,
            promptCapabilities: {
              embeddedContext: true,
              image: false,
              audio: false,
            },
            mcpCapabilities: { http: true, sse: false },
            sessionCapabilities: {
              close: {},
              list: {},
              additionalDirectories: {},
            },
          },
        };
      case "session/new": {
        this.sessionCounter += 1;
        const sessionId = `echo-${this.sessionCounter}`;
        this.sessions.set(sessionId, {
          sessionId,
          cwd: typeof params.cwd === "string" ? params.cwd : "",
          cancelled: false,
          cancelWaiter: null,
        });
        // 对齐 chrys：session/new 后立刻推 runtime_update + usage_update +
        // plan 通知（usage 喂输入区状态行的上下文用量条；runtimeDetails 带
        // MCP/skill 来源，喂 skills/mcp 徽标）
        this.send({
          jsonrpc: "2.0",
          method: "_chrys/runtime_update",
          params: {
            sessionId,
            runtime: {
              sessionId,
              agentProfile: "echo",
              displayName: "Echo Agent",
              modelProfileId: "echo-model",
              maxContextTokens: 128_000,
              toolNames: ["read_file", "run_command"],
              skillNames: [],
              runtimeDetails: {
                model: { name: "echo-model", provider: "mock" },
                mcp_tools: { "echo-mcp": ["echo_tool"] },
                mcp_failures: {},
                skill_sources: {},
              },
            },
          },
        });
        this.send({
          jsonrpc: "2.0",
          method: "_chrys/usage_update",
          params: {
            sessionId,
            usageSourceId: sessionId,
            inputTokens: 12_000,
            outputTokens: 3_000,
            totalTokens: 15_000,
            pct: 11.7,
            maxContextTokens: 128_000,
          },
        });
        this.sendSessionUpdate(sessionId, {
          sessionUpdate: "plan",
          entries: [],
        });
        return {
          sessionId,
          modes: {
            currentModeId: "manual",
            availableModes: [
              { id: "manual", name: "Manual" },
              { id: "auto", name: "Auto" },
              { id: "bypass", name: "Bypass" },
            ],
          },
          models: this.modelsPayload(),
        };
      }
      case "session/load": {
        const sessionId = asString(params.sessionId);
        if (sessionId === null || !this.sessions.has(sessionId)) {
          throw new Error(`未知会话：${sessionId ?? "null"}`);
        }
        return { modes: null, models: this.modelsPayload() };
      }
      case "session/list":
        return {
          sessions: [...this.sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            title: `Echo 会话 ${session.sessionId}`,
            updatedAt: "2026-01-01T00:00:00Z",
          })),
          nextCursor: null,
        };
      case "session/prompt":
        return this.runPromptTurn(params);
      case "session/set_mode": {
        const sessionId = asString(params.sessionId);
        if (sessionId !== null) {
          this.sendSessionUpdate(sessionId, {
            sessionUpdate: "current_mode_update",
            currentModeId: asString(params.modeId) ?? "manual",
          });
        }
        return {};
      }
      case "session/set_model":
        return {};
      case "session/close": {
        const sessionId = asString(params.sessionId);
        if (sessionId !== null) {
          this.sessions.delete(sessionId);
        }
        return {};
      }
      default:
        throw new Error(`method not found: ${method}`);
    }
  }

  // ----------------------------------------------------------------- prompt

  private async runPromptTurn(
    params: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const sessionId = asString(params.sessionId);
    if (sessionId === null || !this.sessions.has(sessionId)) {
      throw new Error(`未知会话：${sessionId ?? "null"}`);
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`未知会话：${sessionId}`);
    }
    session.cancelled = false;
    // 显式 script() 优先且一次性；否则回落常驻剧本
    const script = this.nextScript ?? this.options.defaultTurnScript ?? null;
    this.nextScript = null;
    const turnScript: EchoTurnScript = script ?? {};

    if (turnScript.reverseRequest !== undefined) {
      await this.performReverseRequest(sessionId, turnScript.reverseRequest);
      if (session.cancelled) {
        return { stopReason: "cancelled", usage: null };
      }
    }

    const delayMs = turnScript.interDelayMs ?? 0;
    for (const update of turnScript.updates ?? []) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      if (session.cancelled) {
        return { stopReason: "cancelled", usage: null };
      }
      if ("chrysMethod" in update) {
        this.send({
          jsonrpc: "2.0",
          method: update.chrysMethod,
          params: update.params,
        });
      } else {
        this.sendSessionUpdate(sessionId, update);
      }
    }

    if (turnScript.hangUntilCancelled === true && !session.cancelled) {
      await new Promise<void>((resolve) => {
        session.cancelWaiter = resolve;
      });
    }

    const stopReason = session.cancelled
      ? "cancelled"
      : (turnScript.stopReason ?? "end_turn");
    return {
      stopReason,
      ...(stopReason === "cancelled"
        ? {}
        : { usage: turnScript.usage ?? null }),
    };
  }

  private async performReverseRequest(
    sessionId: string,
    request: NonNullable<EchoTurnScript["reverseRequest"]>,
  ): Promise<void> {
    if (request.kind === "permission") {
      // 客户端答复（wire result）整体记录；脚本预期仅用于编排
      const response = await this.requestFromClient(
        "session/request_permission",
        {
          sessionId,
          toolCall: {
            toolCallId: `perm-${this.sessionCounter}`,
            title: "run_command",
            kind: "execute",
            status: "pending",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        },
      );
      this.receivedRequests.push({
        method: "permission-outcome",
        params: response,
      });
      return;
    }
    const response = await this.requestFromClient("_chrys/request_input", {
      sessionId,
      requestId: `ask-${this.sessionCounter}`,
      questions: [
        {
          question: "选择哪个分支？",
          header: "分支",
          options: [
            { label: "main", description: "主线" },
            { label: "dev", description: "开发" },
          ],
          multiSelect: false,
        },
      ],
      callerName: "echo",
    });
    const answers = Array.isArray(response["answers"])
      ? (response["answers"] as unknown[])
      : null;
    this.receivedRequests.push({
      method: "request-input-outcome",
      params:
        answers !== null && answers.length > 0
          ? { answers }
          : { cancelled: response["cancelled"] === true },
    });
  }

  /** 发起 agent→client 请求并等待响应（Promise 挂起直到 client 答复）。 */
  private requestFromClient(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const pending = new Promise<Readonly<Record<string, unknown>>>(
      (resolve) => {
        this.pendingServerRequests.set(this.nextRequestId, resolve);
      },
    );
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.send({ jsonrpc: "2.0", id: requestId, method, params });
    return pending;
  }

  private nextRequestId = 1_000_000;
  private readonly pendingServerRequests = new Map<
    number,
    (result: Readonly<Record<string, unknown>>) => void
  >();

  // ----------------------------------------------------------------- 通知

  private handleNotification(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    if (method !== "session/cancel") {
      return;
    }
    const sessionId = asString(params.sessionId);
    if (sessionId === null) {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.cancelled = true;
    session.cancelWaiter?.();
    session.cancelWaiter = null;
  }

  // ----------------------------------------------------------------- 输出

  private sendSessionUpdate(
    sessionId: string,
    update: Readonly<Record<string, unknown>>,
  ): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  private send(payload: Readonly<Record<string, unknown>>): void {
    this.peer?.writeLine(JSON.stringify(payload));
  }
}

/** 便捷组装：pair + 已 attach 的 echo agent（测试一行起环境）。 */
export function createEchoAgent(options: EchoAgentOptions = {}): {
  agent: EchoAgent;
  connect(peer: InMemoryPeer): EchoAgent;
} {
  const agent = new EchoAgent(options);
  return {
    agent,
    connect: (peer) => {
      agent.attach(peer);
      return agent;
    },
  };
}

function asString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
