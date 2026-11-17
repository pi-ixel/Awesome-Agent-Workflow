import type { AcpTransport, AcpTransportLaunchOptions } from "../host/types.ts";
import type {
  AcpProbeResult,
  AcpConnectionDiagnostic,
  AcpConnectionPoolPort,
  AcpConnectionPort,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    acpConnection: AcpConnectionService;
  }
}

export interface AcpConnectionService {
  diagnostics(): readonly AcpConnectionDiagnostic[];
  probe(id: string): Promise<AcpProbeResult>;
  createTransport(
    options: AcpTransportLaunchOptions,
  ): Promise<AcpTransport | null>;
  createPool(connect: () => Promise<AcpConnectionPort>): AcpConnectionPoolPort;
  createConnection(
    transport: AcpTransport,
    maxConcurrentRequests: number,
  ): AcpConnectionPort;
  releaseConnection(
    connection: AcpConnectionPort,
    force?: boolean,
  ): Promise<void>;
  shutdown(): Promise<void>;
}

export {
  AcpClosedError,
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
} from "./protocol/errors.ts";
export { AcpWriteError } from "../host/service.ts";
export { ACP_CONNECTION_POOL_SIZE } from "./types.ts";
/**
 * JSON-RPC 连接层的公开出口（ADR 024 §7：工作流节点会话按需求单自建
 * 进程通道，经 host.acpProcess 的 transport 直接装配；跨插件边界只放行
 * 本模块，类本体仍归 protocol/JsonRpcConnection.ts 所有）。
 */
export { JsonRpcConnection } from "./protocol/JsonRpcConnection.ts";
