/**
 * ACP JSON-RPC 2.0 连接层。
 *
 * 职责（对照 Python 参考实现的 _send / _request / _notify / _dispatch）：
 * - 出站：请求（自增 id）与通知，逐行写出并登记 acpTraffic（recordOut）；
 * - 入站：行分帧已由 transport 完成，这里做 JSON 解析与消息分类——
 *   响应（有 id 无 method）按 id 匹配 pending Promise；agent→client
 *   的请求（有 id 有 method）交给 handler 异步处理后回写响应；通知
 *   （无 id）回调派发；
 * - 超时：短请求独立计时（默认 90s）；长任务可显式传 null 等待最终响应。超时
 *   清理挂起项并 reject `AcpTimeoutError`；迟到的响应对已超时请求是
 *   no-op（不会误 resolve 也不会泄漏）；
 * - 错误传播：对端 error 响应 reject `AcpResponseError`；连接关闭 /
 *   进程退出时全部挂起请求 reject `AcpClosedError`。
 *
 * 类型：入站消息一律 `unknown` + 守卫收窄，请求的 resolve 值保持
 * `unknown`，由 session 层按 chrys 方言守卫；出站参数由调用方按
 * types.ts 构造，这里只序列化。
 */

import { acpTraffic, createLogger, type Logger } from "../core/logger.ts";
import { recordAcpRaw } from "../core/acpRawLog.ts";
import {
  AcpClosedError,
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
  AcpWriteError,
} from "./errors.ts";
import { parseJsonObject } from "./framing.ts";
import type { AcpTransport, TransportExit } from "./transport/acpTransport.ts";
import type { JsonRpcId } from "./types.ts";

/** 默认请求超时（对齐 Python 参考的 90s）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

export interface AcpConnectionOptions {
  readonly onExit?: () => void;
  readonly onFailure?: (reason: string) => void;
  /** 请求超时（毫秒），默认 90000。 */
  readonly requestTimeoutMs?: number;
  /** 日志器（channel 建议 "acp"）；缺省不记结构化日志（流量仍登记）。 */
  readonly logger?: Logger;
}

/**
 * agent→client 请求的处理器：返回 result（任意可 JSON 化的值）或抛错
 * （自动回写 error 响应）。
 */
export type ServerRequestHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** 通知回调（session 层在这里把 wire 通知翻译成类型化事件）。 */
export type NotificationHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => void;

interface PendingRequest {
  readonly method: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly timeoutMs: number | null;
  inputWaits: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class AcpConnection {
  private readonly connectionId = crypto.randomUUID();
  private readonly onExit: (() => void) | undefined;
  private nextId = 0;
  private readonly requestScopes = new Map<JsonRpcId, AbortController>();
  requestScope(id: JsonRpcId): { signal: AbortSignal; method: string } | null {
    const controller = this.requestScopes.get(id);
    const pending = this.pending.get(id);
    return controller && pending
      ? { signal: controller.signal, method: pending.method }
      : null;
  }
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger | undefined;
  private closed = false;
  private readonly onFailure: ((reason: string) => void) | undefined;
  private transportExit: TransportExit | null = null;

  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;

  constructor(
    private readonly transport: AcpTransport,
    options: AcpConnectionOptions = {},
  ) {
    this.onExit = options.onExit;
    this.onFailure = options.onFailure;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = (options.logger ?? createLogger("acp")).child({
      connectionId: this.connectionId,
    });
    transport.onLine((line) => this.handleLine(line));
    transport.onStderr((chunk) => {
      const text = chunk.trim();
      if (text.length > 0) {
        this.logger?.warn("agent stderr 输出", { bytes: chunk.length });
        this.logger?.debug("agent stderr 摘要", {
          errorSummary: text.slice(-2000),
        });
      }
    });
    transport.onExit((exit) => this.handleTransportExit(exit));
    transport.onFailure?.((reason) => this.failChannel(reason));
  }

  /** 通知回调（单订阅；session 层在构造后立即设置）。 */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** agent→client 请求处理器（权限审批、结构化提问等）。 */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** 发送请求并等待响应（result 为 unknown，由调用方守卫收窄）。 */
  async request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options: { timeoutMs?: number | null } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new AcpClosedError("ACP 连接已关闭，无法发送请求");
    }
    const id = this.allocateId();
    const scope = new AbortController();
    this.requestScopes.set(id, scope);
    const started = performance.now();
    const context = {
      operationId: `acp-${this.connectionId}-${id}`,
      method,
      requestId: id,
      sessionId:
        typeof params?.sessionId === "string" ? params.sessionId : undefined,
    };
    this.logger?.info("ACP 请求开始", { ...context, stage: "start" });
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload.params = params;
    }
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.requestTimeoutMs
        : options.timeoutMs;

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              if (this.pending.get(id) !== undefined) {
                this.pending.delete(id);
                reject(new AcpTimeoutError(method, timeoutMs));
              }
            }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve,
        reject,
        timeoutMs,
        inputWaits: 0,
      });
    });

    void responsePromise.catch(() => {});
    try {
      this.sendLine(payload);
    } catch (error) {
      this.logger?.error("ACP 请求发送失败", {
        ...context,
        stage: "error",
        durationMs: Math.round(performance.now() - started),
        error: String(error),
      });
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      scope.abort();
      this.requestScopes.delete(id);
      throw error;
    }

    try {
      const result = await responsePromise;
      this.logger?.info("ACP 请求完成", {
        ...context,
        stage: "success",
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      this.logger?.error("ACP 请求失败", {
        ...context,
        stage: "error",
        durationMs: Math.round(performance.now() - started),
        error: String(error),
      });
      throw error;
    } finally {
      scope.abort();
      this.requestScopes.delete(id);
      // 正常 resolve / error 响应路径在 handleResponse 已清理；这里兜底
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
    }
  }

  /** 发送通知（不等待）。默认忽略写入失败；取消等控制操作可要求抛错。 */
  notify(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options: { throwOnError?: boolean } = {},
  ): void {
    if (this.closed) {
      if (options.throwOnError)
        throw new AcpClosedError("ACP 连接已关闭，通知未发送");
      return;
    }
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      payload.params = params;
    }
    try {
      this.sendLine(payload);
    } catch (error) {
      if (options.throwOnError) throw error;
      if (error instanceof AcpWriteError) {
        this.logger?.warn(`通知 ${method} 写入失败（连接已断）`, {
          reason: error.message,
        });
        return;
      }
      throw error;
    }
  }

  /** 回写 agent→client 请求的响应。 */
  respond(id: JsonRpcId, result: unknown): void {
    this.sendLine({ jsonrpc: "2.0", id, result: result ?? null });
  }

  /** 回写 agent→client 请求的错误响应。 */
  respondError(id: JsonRpcId, code: number, message: string): void {
    this.sendLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** 底层 transport（session 层的 close 需要它终止进程）。 */
  get underlying(): AcpTransport {
    return this.transport;
  }

  /** transport 是否已退出（退出即连接终结）。 */
  get exit(): TransportExit | null {
    return this.transportExit;
  }

  // ----------------------------------------------------------------- 内部

  private allocateId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private sendLine(payload: Readonly<Record<string, unknown>>): void {
    const line = JSON.stringify(payload);
    try {
      this.transport.writeLine(line);
    } catch (error) {
      this.failChannel(String(error));
      throw error;
    }
    acpTraffic.recordOut(payload);
    recordAcpRaw(line, this.connectionId, "out");
  }

  private handleLine(line: string): void {
    recordAcpRaw(line, this.connectionId, "in");
    const message = parseJsonObject(line);
    // 流量登记：合法消息记结构，坏行记原文（诊断页仍可见）
    acpTraffic.recordIn(message ?? line);
    if (message === null) {
      this.logger?.warn("收到非 JSON 对象输出", { line: line.slice(0, 400) });
      return;
    }
    const id = message["id"];
    const method = message["method"];
    const hasId = typeof id === "number" || typeof id === "string";
    if (hasId && typeof method === "string") {
      // fire-and-forget 必须自带 .catch：agent 发出请求后立即死亡、
      // 回调迟后答复是常态路径，此时回写必然失败——任何从这里逃逸的
      // rejection 都会成为 unhandled rejection 崩掉 Node 宿主
      this.handleServerRequest(id, method, message).catch((error: unknown) => {
        this.logger?.warn("处理 agent 反向请求时出现意外异常", {
          method,
          reason: describeError(error),
        });
      });
      return;
    }
    if (hasId) {
      this.handleResponse(id, message);
      return;
    }
    if (typeof method === "string") {
      this.handleNotification(method, message["params"]);
      return;
    }
    this.logger?.debug("忽略无法分类的 JSON-RPC 消息", {
      line: line.slice(0, 200),
    });
  }

  private handleResponse(
    id: JsonRpcId,
    message: Readonly<Record<string, unknown>>,
  ): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      // 已超时被清理 / 重复响应：迟到响应是 no-op
      this.logger?.debug("收到无法匹配的响应", { id });
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in message) {
      const error = message["error"];
      const rpcError = isJsonRpcError(error)
        ? error
        : { code: -32603, message: "未知错误结构" };
      this.logger?.error("Agent 返回 JSON-RPC 错误", {
        method: entry.method,
        requestId: id,
        code: rpcError.code,
        message: rpcError.message,
        data: rpcError.data,
        origin: "agent-response",
        connectionClosed: this.closed,
      });
      entry.reject(
        new AcpResponseError(
          entry.method,
          rpcError.code,
          rpcError.message,
          rpcError.data,
        ),
      );
      return;
    }
    entry.resolve(normalizeResult(message["result"]));
  }

  private handleNotification(method: string, params: unknown): void {
    const record = isParamsRecord(params) ? params : {};
    this.notificationHandler?.(method, record);
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    message: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const params = isParamsRecord(message["params"]) ? message["params"] : {};
    const handler = this.serverRequestHandler;
    if (handler === null) {
      this.respondSafely(id, method, () =>
        this.respondError(id, -32601, `method not found: ${method}`),
      );
      return;
    }
    const parentId = params["requestId"];
    const parent =
      method === "elicitation/create" &&
      (typeof parentId === "string" || typeof parentId === "number")
        ? this.pending.get(parentId)
        : undefined;
    if (parent) {
      parent.inputWaits++;
      clearTimeout(parent.timer);
      parent.timer = undefined;
    }
    try {
      const result = await handler(method, params);
      this.respondSafely(id, method, () => this.respond(id, result ?? null));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger?.error("ACP 反向请求处理失败", {
        requestId: id,
        method,
        error: text,
        code: error instanceof AcpMethodNotFoundError ? -32601 : -32000,
      });
      this.respondSafely(id, method, () =>
        this.respondError(
          id,
          error instanceof AcpMethodNotFoundError ? -32601 : -32000,
          text,
        ),
      );
    } finally {
      if (
        parent &&
        (typeof parentId === "string" || typeof parentId === "number")
      ) {
        parent.inputWaits--;
        if (
          parent.inputWaits === 0 &&
          parent.timeoutMs !== null &&
          this.pending.get(parentId) === parent
        ) {
          parent.timer = setTimeout(() => {
            if (this.pending.get(parentId) !== parent) return;
            this.pending.delete(parentId);
            parent.reject(
              new AcpTimeoutError(parent.method, parent.timeoutMs!),
            );
          }, parent.timeoutMs);
        }
      }
    }
  }

  /**
   * 回写 agent→client 请求的响应；通道已断（AcpWriteError）时降级为
   * warn 日志而不是向上抛——对端发出请求后死亡时响应已无处可写，
   * 这里若抛错会沿 handleServerRequest 的 promise 逃逸为
   * unhandled rejection（Node 宿主默认策略下直接崩进程）。其余异常
   * 仍然抛出，交由 handleLine 处的 .catch 兜底。
   */
  private respondSafely(
    id: JsonRpcId,
    method: string,
    write: () => void,
  ): void {
    try {
      write();
    } catch (error) {
      if (error instanceof AcpWriteError) {
        this.logger?.warn(`反向请求 ${method} 的响应无法回写（连接已断）`, {
          id: String(id),
          reason: error.message,
        });
        return;
      }
      throw error;
    }
  }

  private failChannel(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.logger?.error("ACP 通道已失效", { reason });
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new AcpWriteError(reason));
    }
    this.onFailure?.(reason);
  }

  private handleTransportExit(exit: TransportExit): void {
    this.onExit?.();
    this.transportExit = exit;
    this.closed = true;
    // 唤醒所有挂起请求：连接没了，等下去只会是假超时
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(
        new AcpClosedError(
          `ACP 连接已断开（exit code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}），${entry.method} 无法完成`,
        ),
      );
    }
  }
}

/** JSON-RPC result 字段规范化：undefined → null（线上合法值）。 */
function normalizeResult(result: unknown): unknown {
  return result === undefined ? null : result;
}

function isJsonRpcError(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record["code"] === "number" && typeof record["message"] === "string"
  );
}

function isParamsRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
