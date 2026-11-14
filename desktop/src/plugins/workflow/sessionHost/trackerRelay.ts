/**
 * ADR 023 二期-3（§9 第 4 条）→ ADR 024 §5 ②：问题池 tracker 的宿主半边。
 *
 * 引擎不再管理任何进程：需求单（SessionRequirement.question_tracker）携带
 * tracker 启动参数（可执行文件路径 / cwd / QUESTION_TRACKER_HOME 覆盖 /
 * runId 作用域），宿主负责 spawn 并持有进程生命周期；引擎侧
 * QuestionPool 的 tools/list 与 aaw_pool_* 调用经宿主回调帧
 * （StartQuestionTracker / QuestionTrackerRequest，remote_host.rs）到达本
 * 模块，中继到宿主持有的 tracker 进程（stdio JSON-RPC）。
 *
 * 移植自 src/workflow/nativeHost/trackerRelay.ts（commit 24877d9，172 行）：
 * 生产工厂原走 `acp_spawn` IPC 动态 import，改为注入 AcpProcessHost
 * （远端 src/plugins/host/types.ts；生产装配传 ctx.host.acpProcess）——
 * spawn 与行协议经 createHostAcpProcessTransport 换接，wire 契约一致。
 *
 * 握手序列与错误码与桩侧 TrackerClient（headless_host.rs）一致：
 * initialize → notifications/initialized → create_session(作用域)，进程
 * 退出 / 写入失败如实上抛（QUESTION_POOL_*），绝不静默兜底。tracker 的
 * 状态文件按 QUESTION_TRACKER_HOME（或其默认规则）落盘——池子状态路径
 * 规则与迁移前不变，跨进程重启后由引擎侧重新 start 幂等拉回。
 */

import { createLogger } from "../../../shared/logging/logger.ts";
import type { TrackerStartParamsWire } from "../engine/protocol.ts";
import { createHostAcpProcessTransport } from "./transport.ts";

const logger = createLogger("workflow-native-tracker");

/** tracker 传输的最小面：HostAcpProcessTransport 结构上满足它（生产工厂）；
 * 测试注入内存桩。行语义由 Rust 侧保证（完整行才广播）。 */
export interface TrackerTransport {
  readonly isClosed: boolean;
  writeLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (exit: { readonly code: number | null; readonly signal: string | null }) => void): void;
  kill(): Promise<unknown>;
}

/** 生产装配的依赖面：进程端口（ADR 024 §3 作用面 host.acpProcess）。 */
export type TrackerProcessHost = Parameters<
  typeof createHostAcpProcessTransport
>[0];

/** 生产装配：按需求单参数经注入的 AcpProcessHost 拉起 tracker 进程。 */
export async function createTrackerTransport(
  host: TrackerProcessHost,
  params: TrackerStartParamsWire,
): Promise<TrackerTransport> {
  if (typeof params.executable !== "string" || params.executable.length === 0) {
    throw new Error("QUESTION_POOL_SPAWN_FAILED");
  }
  return createHostAcpProcessTransport(host, {
    command: [params.executable],
    cwd: params.cwd,
    extraEnv:
      params.home !== null && params.home !== undefined
        ? { QUESTION_TRACKER_HOME: params.home }
        : undefined,
  });
}

/** 一条挂起的引擎侧 RPC 请求。 */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

/** 宿主持有的一个 tracker 进程连接：JSON-RPC 客户端 + 请求按 id 匹配。 */
export class TrackerRelay {
  private readonly transport: TrackerTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private exitError: Error | null = null;

  constructor(transport: TrackerTransport) {
    this.transport = transport;
    transport.onLine((line) => this.handleLine(line));
    transport.onExit(() => this.handleExit());
  }

  /**
   * 宿主侧握手（幂等启动的一部分）：initialize → notifications/initialized
   * → create_session(作用域)。序列与桩侧 TrackerClient::start 相同。
   */
  async handshake(session: string): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aaw-desktop-workflow", version: "0.1.0" },
    });
    this.transport.writeLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await this.callTool("create_session", {}, session);
    logger.info("问题池 tracker 已由原生宿主拉起", { session });
  }

  /** 引擎侧中继：method/params 原样过线（会话作用域由引擎注入）。 */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.exitError !== null || this.transport.isClosed) {
      return Promise.reject(
        this.exitError ?? new Error("QUESTION_POOL_EXITED"),
      );
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.writeLine(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 收口（运行结束 / 停止 / 宿主解挂）：进程树终止，挂起请求如实拒绝。 */
  async close(): Promise<void> {
    this.handleExit();
    await this.transport.kill().catch(() => undefined);
  }

  private handleLine(line: string): void {
    let value: { id?: unknown; error?: unknown; result?: unknown };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      logger.warn("tracker 输出不是合法 JSON，丢弃", { length: line.length });
      return;
    }
    if (typeof value.id !== "number") {
      return; // 通知/公告行：tracker 无公告义务，原样忽略
    }
    const pending = this.pending.get(value.id);
    if (pending === undefined) {
      return; // 无主 id：静默丢弃（登记表纪律，与 RemoteHost 同语义）
    }
    this.pending.delete(value.id);
    if (value.error !== undefined && value.error !== null) {
      pending.reject(new Error("QUESTION_POOL_RPC_ERROR"));
      return;
    }
    pending.resolve(value.result ?? null);
  }

  private handleExit(): void {
    this.exitError = new Error("QUESTION_POOL_EXITED");
    for (const pending of this.pending.values()) {
      pending.reject(this.exitError);
    }
    this.pending.clear();
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    session: string,
  ): Promise<unknown> {
    const response = (await this.request("tools/call", {
      name,
      arguments: { ...args, session },
    })) as { isError?: boolean; content?: unknown } | null;
    if (
      response !== null &&
      typeof response === "object" &&
      response.isError === true
    ) {
      throw new Error("QUESTION_POOL_TOOL_ERROR");
    }
    return response;
  }
}
