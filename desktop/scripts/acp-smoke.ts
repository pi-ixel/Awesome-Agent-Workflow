import { createAcpSession } from "../src/plugins/acpRuntime/sessions/channelSession.ts";
/// <reference types="node" />
/**
 * ACP 冒烟脚本（tsx 运行：npm run acp:smoke）。
 *
 * 用 AcpConnection 真实连接本机 chrys，验证最小生命周期：
 *   spawn `chrys acp` → initialize → session/new（cwd=系统临时目录）
 *   → session/list → session/close → 进程退出
 *
 * 输出契约：
 * - 成功：stdout 恰好一行 JSON 摘要（protocolVersion、chrys 版本、走通的
 *   请求清单），退出码 0；
 * - 失败：stdout 一行 JSON 摘要（ok:false + failedStep + reason），stderr
 *   打印人类可读详情，退出码 1。
 *
 * 输出纪律：协议层的日志镜像走 console.info/debug/log（默认 stdout），
 * 这里统一重定向到 stderr，保证 stdout 只有最后一行摘要 JSON。
 *
 * 能力降级：session/list 依据 initialize 返回的
 * agentCapabilities.sessionCapabilities.list 判断——chrys 未声明能力或对
 * 请求回 method not found（-32601）时，如实记为 skipped 并继续，不算
 * 失败；initialize / session/new / session/close 是冒烟必经路径，失败即
 * 失败（会话关闭失败仍由 AcpConnection 清理进程，结果如实带入摘要）。
 *
 * 环境变量 CHRYS_ACP_EXE 可覆盖 chrys 可执行文件路径（默认为开发机
 * venv 内的 chrys.exe；覆盖仅供故障注入与异机环境使用）。
 *
 * 纪律：不发送 session/prompt（需要模型配置，超出冒烟范围）。
 */

import { AcpConnection } from "../src/plugins/acpConnection/channels/AcpConnection.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { AcpError } from "../src/contracts/acp/error.ts";
import { AcpResponseError } from "../src/plugins/acpRuntime/service.ts";
import type { AcpSession } from "../src/plugins/acpRuntime/protocol/session.ts";
import { NodeStdioTransport } from "../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";
import type { InitializeResult } from "../src/contracts/acp/protocol.ts";
import { findAgentAdapter } from "../src/plugins/agents/registry/registry.ts";

/**
 * 任务指定的 iCode 可执行文件（可被 CHRYS_ACP_EXE 覆盖）。默认指向开发机
 * chrys 仓库 venv 内的 icode.exe——iCode 0.30 起包里只装 `icode` 命令。
 */
const CHRYS_EXE_DEFAULT = "D:/dev/workspace-ai/chrys/.venv/Scripts/icode.exe";
/** 冒烟请求超时：本机 chrys、无模型调用，30s 足够宽且失败时不用等 90s。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 摘要里每个请求的走通状态。 */
interface StepRecord {
  readonly method: string;
  readonly status: "ok" | "skipped" | "failed";
  /** skipped / failed 的原因。 */
  readonly note?: string;
}

/** stdout 摘要（成功与失败共用一个形状，方便上游解析）。 */
interface SmokeSummary {
  readonly ok: boolean;
  /** 失败步骤（ok:true 时无此字段）。 */
  readonly failedStep?: string;
  /** 失败原因（ok:true 时无此字段）。 */
  readonly reason?: string;
  readonly protocolVersion?: number;
  readonly agent?: { readonly name: string; readonly version?: string };
  readonly requests?: readonly StepRecord[];
  /** session/list 返回的会话数（未走通时无此字段）。 */
  readonly sessionsListed?: number;
  /** 本次新建的 sessionId 是否出现在 list 结果里（诊断用，不作成败判据）。 */
  readonly foundOwnSession?: boolean;
  readonly workspace?: string;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// stdout 纪律：非错误级 console 输出一律改走 stderr
// ---------------------------------------------------------------------------

/** 把 console 的非错误级方法重定向到 stderr（必须在协议层输出前生效）。 */
function redirectConsoleToStderr(): void {
  const passthrough = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = passthrough;
  console.info = passthrough;
  console.debug = passthrough;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const startedAt = Date.now();
const steps: StepRecord[] = [];

/** 脚本持有的可清理资源（失败路径也要终止进程、删除临时目录）。 */
const cleanup: { connection: AcpConnection | null; workspace: string | null } =
  {
    connection: null,
    workspace: null,
  };

async function main(): Promise<number> {
  redirectConsoleToStderr();

  const chrysExe = process.env["CHRYS_ACP_EXE"] ?? CHRYS_EXE_DEFAULT;
  if (!fs.existsSync(chrysExe)) {
    return fail("spawn", `chrys 可执行文件不存在：${chrysExe}`);
  }

  // 系统临时目录下的一次性工作区：chrys 会把会话状态写进 cwd，
  // 独立子目录避免污染 tmp 根部，跑完即删
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aaw-acp-smoke-"));
  cleanup.workspace = workspace;
  process.stderr.write(`[smoke] 工作区 ${workspace}\n`);

  // 启动描述来自 agents 注册表（buildLaunch），本脚本不手写 argv——
  // 与真实运行（runtime/acp/runtimeHost）共用同一份 launch 知识
  const adapter = findAgentAdapter("chrys");
  if (adapter === null) {
    return fail("spawn", "agents 注册表中没有 chrys 适配项");
  }
  const launch = adapter.buildLaunch({
    workspacePath: workspace,
    executablePath: chrysExe,
  });
  if (launch.cwd === null) {
    return fail("spawn", "chrys 适配项未产出启动 cwd");
  }
  const transport = new NodeStdioTransport({
    command: launch.command,
    cwd: launch.cwd,
    extraEnv: launch.extraEnv,
  });
  const connection = new AcpConnection(
    transport,
    adapter.maxConcurrentRequests ?? 1,
  );
  cleanup.connection = connection;
  const session = createAcpSession(connection, {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    clientInfo: { name: "aaw-desktop-smoke", version: "0.1.0" },
  });
  process.stderr.write(
    `[smoke] chrys acp 已启动 · PID ${String(transport.pid)}\n`,
  );

  // --- initialize（含版本协商；协商失败由协议层抛 AcpHandshakeError）---
  const init = await session.initialize();
  steps.push({ method: "initialize", status: "ok" });
  process.stderr.write(
    `[smoke] initialize ✓ protocolVersion=${String(init.protocolVersion)} agent=${init.agentInfo.name} ${init.agentInfo.version ?? "?"}\n`,
  );

  // --- session/new（cwd = 临时工作区）---
  const created = await session.newSession(workspace);
  steps.push({ method: "session/new", status: "ok" });
  process.stderr.write(
    `[smoke] session/new ✓ sessionId=${created.sessionId}\n`,
  );

  // --- session/list（能力降级见函数头注释）---
  const listOutcome = await runSessionList(
    session,
    init,
    workspace,
    created.sessionId,
  );
  steps.push(listOutcome.step);
  if (listOutcome.step.status === "failed") {
    return fail("session/list", listOutcome.step.note ?? "session/list 失败");
  }

  // --- session/close 与连接关闭分别验证 ---
  let sessionClose: "ok" | "failed" = "ok";
  let sessionCloseReason: string | undefined;
  try {
    await session.closeSession();
  } catch (error) {
    sessionClose = "failed";
    sessionCloseReason = describeError(error);
  }
  const exit = await connection.close();
  const outcome = { sessionClose, sessionCloseReason, exit };
  steps.push(
    outcome.sessionClose === "ok"
      ? { method: "session/close", status: "ok" }
      : {
          method: "session/close",
          status: outcome.sessionClose,
          note: outcome.sessionCloseReason,
        },
  );
  process.stderr.write(
    `[smoke] session/close ${outcome.sessionClose} · 进程退出 code=${String(outcome.exit.code)} signal=${String(outcome.exit.signal)}\n`,
  );
  if (outcome.sessionClose !== "ok") {
    return fail(
      "session/close",
      outcome.sessionCloseReason ?? "session/close 未走通",
    );
  }
  cleanup.connection = null; // close 已完成进程清理

  finish({
    ok: true,
    protocolVersion: init.protocolVersion,
    agent: init.agentInfo,
    requests: steps,
    ...(listOutcome.listed === null
      ? {}
      : {
          sessionsListed: listOutcome.listed.sessionCount,
          foundOwnSession: listOutcome.listed.foundOwn,
        }),
    workspace,
    elapsedMs: Date.now() - startedAt,
  });
  return 0;
}

/** session/list 结果：步骤记录 + 摘要附加字段（listed=null 表示未走通）。 */
interface SessionListOutcome {
  readonly step: StepRecord;
  readonly listed: {
    readonly sessionCount: number;
    readonly foundOwn: boolean;
  } | null;
}

/**
 * session/list 的能力降级封装：
 * - agentCapabilities 未声明 sessionCapabilities.list → skipped；
 * - 声明了却回 -32601（method not found）→ skipped（如实记录服务端行为）；
 * - 其余错误（超时 / 内部错误）→ failed，冒烟失败。
 */
async function runSessionList(
  session: AcpSession,
  init: InitializeResult,
  workspace: string,
  ownSessionId: string,
): Promise<SessionListOutcome> {
  // initialize 的 agentCapabilities 按协议层约定原样透传（unknown 容器），
  // 这里守卫收窄读取 sessionCapabilities.list（写法对齐 session.ts 的 asRecord）
  const caps = init.agentCapabilities;
  const sessionCaps =
    typeof caps["sessionCapabilities"] === "object" &&
    caps["sessionCapabilities"] !== null &&
    !Array.isArray(caps["sessionCapabilities"])
      ? (caps["sessionCapabilities"] as Readonly<Record<string, unknown>>)
      : null;
  if (sessionCaps === null || !("list" in sessionCaps)) {
    process.stderr.write(
      "[smoke] session/list skipped：agentCapabilities 未声明 list 能力\n",
    );
    return {
      step: {
        method: "session/list",
        status: "skipped",
        note: "agentCapabilities.sessionCapabilities.list 未声明，按能力降级跳过",
      },
      listed: null,
    };
  }
  try {
    const listed = await session.listSessions(workspace);
    const found = listed.sessions.some(
      (entry) => entry.sessionId === ownSessionId,
    );
    process.stderr.write(
      `[smoke] session/list ✓ 返回 ${String(listed.sessions.length)} 个会话（本次会话${found ? "" : "未"}包含在内）\n`,
    );
    return {
      step: { method: "session/list", status: "ok" },
      listed: { sessionCount: listed.sessions.length, foundOwn: found },
    };
  } catch (error) {
    if (error instanceof AcpResponseError && error.jsonRpcCode === -32601) {
      process.stderr.write(
        "[smoke] session/list skipped：服务端回应 method not found\n",
      );
      return {
        step: {
          method: "session/list",
          status: "skipped",
          note: `服务端声明能力但对 session/list 回 -32601：${error.jsonRpcMessage}`,
        },
        listed: null,
      };
    }
    // 其他错误按冒烟失败处理（原因走 describeError）
    return {
      step: {
        method: "session/list",
        status: "failed",
        note: describeError(error),
      },
      listed: null,
    };
  }
}

// ---------------------------------------------------------------------------
// 失败与收尾
// ---------------------------------------------------------------------------

/** 失败出口：stderr 详情 + stdout 一行 JSON + 进程/工作区清理，返回退出码 1。 */
async function fail(step: string, reason: string): Promise<number> {
  process.stderr.write(`[smoke] 失败于 ${step}：${reason}\n`);
  // 进程清理：close 未走过的路径用 kill 兜底（kill 幂等，已退出时直接返回）
  if (cleanup.connection !== null) {
    try {
      await cleanup.connection.kill();
    } catch (error) {
      process.stderr.write(
        `[smoke] 进程清理失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    cleanup.connection = null;
  }
  finish({
    ok: false,
    failedStep: step,
    reason,
    requests: steps,
    elapsedMs: Date.now() - startedAt,
  });
  return 1;
}

/** stdout 摘要恒为一行 JSON；随后尽力清理临时工作区（失败不算冒烟失败）。 */
function finish(summary: SmokeSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const workspace = cleanup.workspace;
  if (workspace !== null) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `[smoke] 临时工作区未能删除（${error instanceof Error ? error.message : String(error)}）：${workspace}\n`,
      );
    }
  }
}

/** 错误 → 摘要 reason 文本（AcpError 带 machineCode 便于分诊）。 */
function describeError(error: unknown): string {
  if (error instanceof AcpError) {
    return `${error.machineCode}: ${error.message}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// ---------------------------------------------------------------------------
// 入口：main 内任何一步异常都走同一失败出口
// ---------------------------------------------------------------------------

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const step = lastStep === undefined ? "spawn" : `after:${lastStep.method}`; // 异常发生在该步骤的执行中
    process.exitCode = await fail(step, describeError(error));
  });

// 兜底：主流程之外的意外 rejection 同样以退出码 1 结束（不算通过）
process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(
    `[smoke] unhandledRejection：${describeError(reason)}\n`,
  );
  process.exitCode = 1;
});
