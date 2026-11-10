import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import { AcpResponseError } from "../../acpConnection/service.ts";
/**
 * Agent 插件的协议自检流程，通过注入的传输和会话租约执行。
 * 对一个 agent 真实 spawn 一条 ACP 连接，走完安全链路并收集画像——
 *
 * - 安全探查（depth=safe，零模型调用）：initialize → session/new →
 *   短暂停收早期通知（chrys 推 _chrys/runtime_update；OpenCode 推
 *   命名空间 session/update:* 的 available_commands）→ session/list →
 *   close；
 * - 深度探查（depth=deep）：跳过停收，发两轮真实对话——轮 1 轻量回复，
 *   轮 2 多步任务（列目录 + 跑命令，触发思考/工具/计划/审批）——两轮
 *   之后仍未出现的对话类能力才是真缺失；agent 未配凭证时如实记为
 *   prompt 失败，链路其余部分照常收口。
 *
 * 探查中不做任何审批放行：权限/提问反向请求一律计数后回「取消」
 * （安全默认，绝不替用户允许任何操作）。结果不累计——每次全量覆盖。
 */
import type { AcpTransport } from "../../host/types.ts";
import type { AgentAdapter, AgentLaunch } from "../registry/adapterTypes.ts";
import {
  type AgentProbeResult,
  type AgentProbeSessionFactory,
  type ProbeListOutcome,
  type ProbePromptOutcome,
} from "./types.ts";
import type { ConnectionTestResult } from "../types.ts";

/** 轮 1：轻量回复——验证消息流与 stopReason。 */
const DEEP_TURN1_TEXT = "请只回复两个字：完成。";
/**
 * 轮 2：多步任务——列目录（read/list 类工具）+ 跑命令（execute 类工具，
 * 可能触发权限审批），两步并一行大概率促使 agent 建计划。不需要预置
 * 任何文件，不污染探查工作区。
 */
const DEEP_TURN2_TEXT =
  "请依次完成两件事：1) 列出当前目录下的文件，告诉我大约有几个；2) 运行一条命令输出 probe-ok。完成后分别简要汇报。";
/** 短请求超时：覆盖冷启动 agent（spawn + 握手可能到 10s 量级）。 */
const REQUEST_TIMEOUT_MS = 60_000;
/** 安全探查在 session/new 后停收早期通知的时长。 */
const EARLY_NOTIFICATION_SETTLE_MS = 1_200;

export interface AgentProbeResources {
  readonly createLease: AgentProbeSessionFactory;
  readonly createTransport: (
    launch: AgentLaunch,
    adapter: AgentAdapter,
  ) => Promise<AcpTransport | null>;
  readonly signal?: AbortSignal;
}

interface ConnectionTestOptions extends AgentProbeResources {
  readonly executablePath?: string;
  readonly transport?: AcpTransport;
  readonly onStep?: (step: string) => void;
}

export interface AgentProbeOptions extends ConnectionTestOptions {
  readonly depth: "safe" | "deep";
  /** 探查用工作区（session/new 的 cwd；session/list 也按它过滤）。 */
  readonly cwd: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("ACP 探查已取消", { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function releaseUnboundTransport(transport: AcpTransport): Promise<void> {
  await transport.close(2_000).catch(() => transport.kill());
  await transport.dispose?.();
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** Start an independent process and check only the ACP handshake. */
export async function testAgentConnection(
  adapter: AgentAdapter,
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const { executablePath, onStep, signal } = options;
  let transport = options.transport ?? null;
  let lease: ReturnType<AgentProbeSessionFactory> | undefined;
  let stderr = "";
  let outcome: ConnectionTestResult;
  let stage = "启动进程";
  try {
    onStep?.(stage);
    signal?.throwIfAborted();
    transport ??= await options.createTransport(
      adapter.buildLaunch({ workspacePath: null, executablePath }),
      adapter,
    );
    if (transport === null) throw new Error("当前环境无法启动 Agent 进程");
    transport.onStderr((chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    lease = options.createLease(
      transport,
      adapter.maxConcurrentRequests ?? 1,
      {
        cancellationGraceMs: adapter.cancellationGraceMs,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        clientInfo: adapter.clientInfo,
      },
    );
    const session = lease.openSession();
    stage = "ACP 握手";
    onStep?.(stage);
    signal?.throwIfAborted();
    const result = await session.initialize();
    signal?.throwIfAborted();
    outcome = {
      ok: true,
      message: `连接成功：${result.agentInfo.name}${result.agentInfo.version ? ` ${result.agentInfo.version}` : ""}，ACP v${String(result.protocolVersion)}`,
      stderr,
    };
  } catch (error) {
    outcome = {
      ok: false,
      message: `${stage}失败：${describeError(error)}`,
      stderr,
    };
  } finally {
    try {
      if (lease) await lease.release(signal?.aborted);
      else if (transport) await releaseUnboundTransport(transport);
    } catch (error) {
      outcome = {
        ok: false,
        message: `进程清理失败：${describeError(error)}`,
        stderr,
      };
    }
  }
  if (outcome.ok && signal?.aborted)
    return { ok: false, message: "ACP 探查已取消", stderr };
  return outcome;
}

/** 一次探查的执行现场（计数器可变，结果组装时快照为只读）。 */
interface ProbeRun {
  eventTypeCounts: Record<string, number>;
  toolKindCounts: Record<string, number>;
  rawMethodCounts: Record<string, number>;
  permissionRequests: number;
  questionRequests: number;
}

/**
 * 对一个 agent 跑一次探查。函数不抛出：任何失败都收进结果的
 * failedStep / failureReason（spawn 失败、握手失败、建会话失败等
 * 链路级失败 ok=false；深度探查的 prompt 失败是观测数据，ok 不受影响）。
 */
export async function runAgentProbe(
  adapter: AgentAdapter,
  options: AgentProbeOptions,
): Promise<AgentProbeResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const step = (text: string): void => {
    options.signal?.throwIfAborted();
    options.onStep?.(text);
  };
  const run: ProbeRun = {
    eventTypeCounts: {},
    toolKindCounts: {},
    rawMethodCounts: {},
    permissionRequests: 0,
    questionRequests: 0,
  };

  const base = {
    agentId: adapter.id,
    agentLabel: adapter.displayName,
    depth: options.depth,
    startedAt,
  };
  const failed = (
    failedStep: string,
    failureReason: string,
  ): AgentProbeResult => ({
    ...base,
    elapsedMs: Date.now() - t0,
    ok: false,
    failedStep,
    failureReason,
    protocolVersion: null,
    agentName: null,
    agentVersion: null,
    capabilities: null,
    models: null,
    modes: null,
    list: null,
    closeAck: null,
    events: snapshotTally(run),
    permissionRequests: run.permissionRequests,
    questionRequests: run.questionRequests,
    prompts: [],
  });

  // —— spawn（transport 就绪即视为进程已拉起）——
  step("启动 agent 进程");
  let transport: AcpTransport | null = options.transport ?? null;
  if (transport === null) {
    const launch = adapter.buildLaunch({
      workspacePath: options.cwd,
      executablePath: options.executablePath,
    });
    try {
      transport = await options.createTransport(launch, adapter);
    } catch (error) {
      return failed("启动进程", describeError(error));
    }
    if (transport === null) {
      return failed(
        "spawn",
        "当前环境无法启动 agent 进程（需要桌面宿主或 dev bridge）",
      );
    }
  }

  // —— 链路主段：任何一步异常收进 failedStep，进程务必清理 ——
  let protocolVersion: number | null = null;
  let agentName: string | null = null;
  let agentVersion: string | null = null;
  let capabilities: Readonly<Record<string, unknown>> | null = null;
  let models: AgentProbeResult["models"] = null;
  let modes: AgentProbeResult["modes"] = null;
  let listOutcome: ProbeListOutcome | null = null;
  const prompts: ProbePromptOutcome[] = [];
  let closeAck: boolean | null = null;
  let failure: { readonly step: string; readonly reason: string } | null = null;
  let lease: ReturnType<AgentProbeSessionFactory> | undefined;
  let openedSession: AcpSessionPort | undefined;

  try {
    lease = options.createLease(transport, adapter.maxConcurrentRequests ?? 1, {
      cancellationGraceMs: adapter.cancellationGraceMs,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      clientInfo: adapter.clientInfo,
      dialect: adapter.createDialect?.({
        onQuestion: () => {
          run.questionRequests += 1;
          return Promise.resolve(null);
        },
      }),
      onPermissionRequest: () => {
        run.permissionRequests += 1;
        return Promise.resolve({ outcome: "cancelled" });
      },
    });
    const session = (openedSession = lease.openSession());
    session.onEvent((event) => tallyEvent(run, event));
    step("握手 initialize");
    const init = await session.initialize();
    protocolVersion = init.protocolVersion;
    agentName = init.agentInfo.name;
    agentVersion = init.agentInfo.version ?? null;
    capabilities = init.agentCapabilities;

    step("新建会话 session/new");
    const created = await session.newSession(options.cwd);
    models = created.models ?? null;
    modes = created.modes ?? null;

    if (options.depth === "deep") {
      // 两轮真实对话（每轮消耗一次模型调用）：
      // 轮 1 轻量回复——验证消息流与 stopReason；
      // 轮 2 多步任务（列目录 + 跑命令）——真实触发思考流、工具调用、
      // 计划与权限审批；两轮之后仍未出现的对话类能力才是真缺失。
      step("深度对话 · 轮 1/2：轻量回复");
      try {
        const turn = await session.prompt(DEEP_TURN1_TEXT, {
          timeoutMs: 90_000,
        });
        prompts.push({ status: "ok", stopReason: turn.stopReason });
      } catch (error) {
        prompts.push({
          status: "failed",
          stopReason: null,
          reason: describeError(error),
        });
      }
      step("深度对话 · 轮 2/2：多步任务（列目录 + 跑命令）");
      try {
        const turn = await session.prompt(DEEP_TURN2_TEXT, {
          timeoutMs: 120_000,
        });
        prompts.push({ status: "ok", stopReason: turn.stopReason });
      } catch (error) {
        prompts.push({
          status: "failed",
          stopReason: null,
          reason: describeError(error),
        });
      }
    } else {
      step("收早期通知");
      await delay(EARLY_NOTIFICATION_SETTLE_MS, options.signal);
    }

    step("列出会话 session/list");
    try {
      const listed = await session.listSessions(options.cwd);
      listOutcome = { status: "ok", count: listed.sessions.length };
    } catch (error) {
      listOutcome = {
        status:
          error instanceof AcpResponseError && error.jsonRpcCode === -32601
            ? "unsupported"
            : "failed",
        count: null,
        reason: describeError(error),
      };
    }

    step("关闭会话");
    try {
      await session.closeSession();
      closeAck = true;
    } catch {
      closeAck = false;
    }
  } catch (error) {
    failure = { step: "连接链路", reason: describeError(error) };
  } finally {
    // Session release and process termination have different owners.
    try {
      if (lease) {
        if (!options.signal?.aborted)
          await openedSession?.closeSession().catch(() => undefined);
        await lease.release(options.signal?.aborted);
      } else await releaseUnboundTransport(transport);
    } catch (error) {
      failure = { step: "进程清理", reason: describeError(error) };
    }
  }

  if (failure === null && options.signal?.aborted)
    failure = { step: "连接链路", reason: "ACP 探查已取消" };

  return {
    ...base,
    elapsedMs: Date.now() - t0,
    ok: failure === null,
    failedStep: failure?.step ?? null,
    failureReason: failure?.reason ?? null,
    protocolVersion,
    agentName,
    agentVersion,
    capabilities,
    models,
    modes,
    list: listOutcome,
    closeAck,
    events: snapshotTally(run),
    permissionRequests: run.permissionRequests,
    questionRequests: run.questionRequests,
    prompts,
  };
}

function tallyEvent(run: ProbeRun, event: AcpSessionEvent): void {
  run.eventTypeCounts[event.type] = (run.eventTypeCounts[event.type] ?? 0) + 1;
  if (event.type === "tool_call") {
    const kind = event.kind;
    if (typeof kind === "string") {
      run.toolKindCounts[kind] = (run.toolKindCounts[kind] ?? 0) + 1;
    }
  }
  if (
    event.type === "unknown_notification" ||
    event.type === "agent_extension"
  ) {
    const method = event.method;
    if (typeof method === "string") {
      run.rawMethodCounts[method] = (run.rawMethodCounts[method] ?? 0) + 1;
    }
  }
}

function snapshotTally(run: ProbeRun): AgentProbeResult["events"] {
  return {
    eventTypeCounts: { ...run.eventTypeCounts },
    toolKindCounts: { ...run.toolKindCounts },
    rawMethodCounts: { ...run.rawMethodCounts },
  };
}
