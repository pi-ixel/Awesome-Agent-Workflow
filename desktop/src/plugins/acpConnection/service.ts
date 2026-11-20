import type { AcpTransport, AcpTransportLaunchOptions } from "../host/types.ts";
import type {
  AcpProbeResult,
  AcpConnectionDiagnostic,
  AcpSharedConnectionPoolPort,
  AcpConnectionPort,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    acpConnection: AcpConnectionService;
  }
}

/**
 * 插件可见的连接服务面。**不含建池能力**：连接池是桌面端唯一的 Agent
 * 进程资源（ADR 024 §7），只允许 acpRuntime 的资源层（sessions/connections）
 * 经 AcpConnectionInternals 装配——任何插件不得自建第二支队伍。
 */
export interface AcpConnectionService {
  diagnostics(): readonly AcpConnectionDiagnostic[];
  probe(id: string): Promise<AcpProbeResult>;
  createTransport(
    options: AcpTransportLaunchOptions,
    purpose?: "diagnostic",
  ): Promise<AcpTransport | null>;
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

/**
 * 建池入口（收进 acpRuntime 单点装配；架构守卫
 * tests/architecture/acpPoolBoundary.test.ts 只放行
 * acpRuntime/sessions/connections.ts 一处引用）。
 */
export interface AcpConnectionInternals extends AcpConnectionService {
  createPool(
    connect: () => Promise<AcpConnectionPort>,
    key?: string,
  ): AcpSharedConnectionPoolPort;
}

export {
  AcpClosedError,
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
  AcpUnconfirmedCleanupError,
} from "./protocol/errors.ts";
export { AcpWriteError } from "../host/service.ts";
export { ACP_CONNECTION_POOL_SIZE } from "./types.ts";
/**
 * JSON-RPC 连接层的公开出口（ADR 024 §7：工作流节点会话按需求单自建
 * 进程通道，经 host.acpProcess 的 transport 直接装配；跨插件边界只放行
 * 本模块，类本体仍归 protocol/JsonRpcConnection.ts 所有）。
 */
export { JsonRpcConnection } from "./protocol/JsonRpcConnection.ts";
