/**
 * ACP 协议层错误类型。
 *
 * 分类对齐 skill-eval 的 Python 参考实现（session.py 的
 * InfrastructureError 码：ACP_CLOSED / ACP_WRITE_FAILED /
 * ACP_REQUEST_TIMEOUT / ACP_INIT_FAILED / ACP_SESSION_FAILED），
 * 便于跨语言排查同一类故障。
 */

/** ACP 层错误基类：machineCode 供程序分支，message 供日志与人读。 */
export class AcpError extends Error {
  constructor(
    readonly machineCode: string,
    message: string,
    cause?: unknown,
  ) {
    // ES2022 Error 构造器原生支持 cause（不再声明同名字段覆盖）
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AcpError";
  }
}

/** 请求发出后超过配置时限仍未收到响应。 */
export class AcpTimeoutError extends AcpError {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(
      "ACP_REQUEST_TIMEOUT",
      `ACP agent 未在 ${timeoutMs}ms 内应答 ${method}`,
    );
    this.name = "AcpTimeoutError";
  }
}

/** agent 对请求返回了 JSON-RPC error。 */
export class AcpResponseError extends AcpError {
  constructor(
    readonly method: string,
    readonly jsonRpcCode: number,
    readonly jsonRpcMessage: string,
    readonly data?: unknown,
  ) {
    super(
      "ACP_RESPONSE_ERROR",
      `ACP agent 对 ${method} 返回错误 ${jsonRpcCode}：${jsonRpcMessage}`,
    );
    this.name = "AcpResponseError";
  }
}

/** 进程/通道已关闭仍尝试写入，或等待期间连接断开。 */
export class AcpClosedError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super("ACP_CLOSED", message, cause);
    this.name = "AcpClosedError";
  }
}

/** 底层写入失败（stdin 管道断裂等）。 */
export class AcpWriteError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super("ACP_WRITE_FAILED", message, cause);
    this.name = "AcpWriteError";
  }
}

/** 握手（initialize / 版本协商）失败。 */
export class AcpHandshakeError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super("ACP_INIT_FAILED", message, cause);
    this.name = "AcpHandshakeError";
  }
}

/** agent 进程意外退出（非主动 close）。 */
export class AcpProcessExitError extends AcpError {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: string | null,
  ) {
    super("ACP_PROCESS_EXITED", message);
    this.name = "AcpProcessExitError";
  }
}

/** Client does not implement this optional reverse request. */
export class AcpMethodNotFoundError extends AcpError {
  constructor(method: string) {
    super("ACP_METHOD_NOT_FOUND", `method not found: ${method}`);
  }
}
