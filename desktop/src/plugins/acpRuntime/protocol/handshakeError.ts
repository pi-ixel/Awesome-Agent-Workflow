import { AcpError } from "../../../contracts/acp/error.ts";

/** 握手（initialize / 版本协商）失败。 */
export class AcpHandshakeError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super("ACP_INIT_FAILED", message, cause);
    this.name = "AcpHandshakeError";
  }
}
