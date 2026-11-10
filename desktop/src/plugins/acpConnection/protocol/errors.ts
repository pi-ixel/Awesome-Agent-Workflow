import { AcpError } from "../../../contracts/acp/error.ts";

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

/** Client does not implement this optional reverse request. */
export class AcpMethodNotFoundError extends AcpError {
  constructor(method: string) {
    super("ACP_METHOD_NOT_FOUND", `method not found: ${method}`);
  }
}
