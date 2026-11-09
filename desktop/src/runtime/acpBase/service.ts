import type { AcpTransport } from "./protocol/transport/acpTransport.ts";
import type { AcpConnection } from "./AcpConnection.ts";
import type { AcpConnectionPool } from "./AcpConnectionPool.ts";

export interface AcpBaseService {
  createPool(connect: () => Promise<AcpConnection>): AcpConnectionPool;
  createConnection(
    transport: AcpTransport,
    maxConcurrentRequests: number,
  ): AcpConnection;
  shutdown(): Promise<void>;
}
