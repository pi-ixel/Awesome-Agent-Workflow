import type { JsonRpcId } from "../../contracts/acp/protocol.ts";
import type { TransportExit } from "../host/types.ts";

export interface AcpConnectionDiagnostic {
  readonly id: string;
  readonly state: "initializing" | "ready" | "failed" | "closing";
  readonly processHandle?: number;
  readonly sessions: readonly {
    readonly id: string;
    readonly running: boolean;
    readonly state: "ready" | "loading";
    readonly project?: { readonly id: string; readonly path: string };
  }[];
  readonly probe: AcpProbeResult | null;
}

export interface AcpProbeResult {
  readonly at: number;
  readonly status:
    "success" | "busy" | "unsupported" | "no-project" | "unavailable" | "error";
  readonly durationMs?: number;
  readonly message?: string;
}

/** Protocol policy supplied by the caller. Requests must be read-only. */
export type AcpDiagnosticProbePlan = (projectCwd: string | undefined) =>
  | {
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly status: "unsupported" | "no-project" };

export type ServerRequestHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export type NotificationHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => void;

export interface AcpSessionConnection {
  readonly diagnosticScope?: string;
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { timeoutMs?: number | null; beforeDispatch?: () => void },
  ): Promise<unknown>;
  notify(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { throwOnError?: boolean },
  ): void;
  requestScope(id: JsonRpcId): {
    signal: AbortSignal;
    method: string;
    sessionId?: string;
  } | null;
  setNotificationHandler(handler: NotificationHandler): void;
  setServerRequestHandler(handler: ServerRequestHandler): void;
}

export interface AcpChannelOptions {
  readonly diagnosticScope?: string;
  readonly background?: boolean;
  readonly elicitation?: boolean;
  readonly requestTimeoutMs?: number;
  readonly minimumProcessRevision?: number;
  readonly onFailure?: (reason: string) => void;
  /** Product identity supplied by the project owner; absent for temporary channels. */
  readonly project?: { readonly id: string; readonly path: string };
}

export interface AcpChannel {
  readonly port: AcpSessionConnection;
  close(): void;
  promote(): void;
  escalate(): Promise<unknown>;
}

export interface AcpChannelLease extends AcpChannel {
  readonly processRevision?: number;
  release(closeRemote: () => Promise<void>): Promise<void>;
  recover(): Promise<void>;
}

export interface AcpConnectionPort {
  readonly available: boolean;
  readonly runningRequests: number;
  readonly boundSessions: number;
  configureDiagnosticProbe(plan: AcpDiagnosticProbePlan): void;
  onUnavailable(listener: (reason: Error) => void): () => void;
  openChannel(options?: AcpChannelOptions): AcpChannel;
  close(): Promise<TransportExit>;
  kill(): Promise<TransportExit>;
}

/** Desktop 物理连接总额度，包含启动、任务及切换中的连接。 */
export const ACP_CONNECTION_POOL_SIZE = 4;

export interface AcpConnectionPoolPort {
  readonly size: number;
  readonly recoveryError: unknown;
  ensureAvailable(): Promise<void>;
  warm(): Promise<void>;
  prepareSwitch(connect: () => Promise<AcpConnectionPort>): Promise<number>;
  abortSwitch(revision: number): Promise<void>;
  commitSwitch(revision: number): Promise<void>;
  openChannel(options?: AcpChannelOptions): AcpChannelLease;
  acquireChannel?(options?: AcpChannelOptions): Promise<AcpChannelLease>;
  shutdown(options?: { force?: boolean }): Promise<void>;
}

/** 不同启动配置共用同一份物理额度，会话和请求调度仍各自隔离。 */
export interface AcpSharedConnectionPoolPort extends AcpConnectionPoolPort {
  scope(
    key: string,
    connect: () => Promise<AcpConnectionPort>,
  ): AcpConnectionPoolPort;
  selectConfiguration(key: string): void;
  prepareConfiguration(
    key: string,
    connect: () => Promise<AcpConnectionPort>,
  ): Promise<number>;
}
