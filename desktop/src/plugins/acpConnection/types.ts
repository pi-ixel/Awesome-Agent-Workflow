import type { JsonRpcId } from "../../contracts/acp/protocol.ts";
import type { TransportExit } from "../host/types.ts";

export type ServerRequestHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export type NotificationHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => void;

export interface AcpSessionConnection {
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { timeoutMs?: number | null },
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
  readonly background?: boolean;
  readonly elicitation?: boolean;
  readonly requestTimeoutMs?: number;
  readonly onFailure?: (reason: string) => void;
}

export interface AcpChannel {
  readonly port: AcpSessionConnection;
  close(): void;
  promote(): void;
  escalate(): Promise<unknown>;
}

export interface AcpChannelLease extends AcpChannel {
  release(closeRemote: () => Promise<void>): Promise<void>;
  recover(): Promise<void>;
}

export interface AcpConnectionPort {
  readonly available: boolean;
  readonly runningRequests: number;
  readonly boundSessions: number;
  onUnavailable(listener: (reason: Error) => void): () => void;
  openChannel(options?: AcpChannelOptions): AcpChannel;
  close(): Promise<TransportExit>;
  kill(): Promise<TransportExit>;
}

export interface AcpConnectionPoolPort {
  readonly size: number;
  readonly recoveryError: unknown;
  ensureAvailable(): Promise<void>;
  warm(): Promise<void>;
  prepareSwitch(connect: () => Promise<AcpConnectionPort>): Promise<number>;
  abortSwitch(revision: number): Promise<void>;
  commitSwitch(revision: number): Promise<void>;
  openChannel(options?: AcpChannelOptions): AcpChannelLease;
  shutdown(options?: { force?: boolean }): Promise<void>;
}
