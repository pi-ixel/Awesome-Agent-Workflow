import { AcpError } from "../../../contracts/acp/error.ts";

/** 底层写入失败（stdin 管道断裂等）。 */
export class AcpWriteError extends AcpError {
  constructor(message: string, cause?: unknown) {
    super("ACP_WRITE_FAILED", message, cause);
    this.name = "AcpWriteError";
  }
}
