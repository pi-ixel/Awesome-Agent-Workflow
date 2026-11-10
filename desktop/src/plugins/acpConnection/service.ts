import type { AcpTransport, AcpTransportLaunchOptions } from "../host/types.ts";
import type { AcpConnectionPoolPort, AcpConnectionPort } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    acpConnection: AcpConnectionService;
  }
}

export interface AcpConnectionService {
  createTransport(options: AcpTransportLaunchOptions): Promise<AcpTransport | null>;
  createPool(connect: () => Promise<AcpConnectionPort>): AcpConnectionPoolPort;
  createConnection(
    transport: AcpTransport,
    maxConcurrentRequests: number,
  ): AcpConnectionPort;
  releaseConnection(connection: AcpConnectionPort, force?: boolean): Promise<void>;
  shutdown(): Promise<void>;
}

export {
  AcpClosedError,
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
} from "./protocol/errors.ts";
export { AcpWriteError } from "../host/service.ts";
