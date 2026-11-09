import type {
  AcpConnectionPort,
  AcpConnectionService,
  AcpTransportLaunchOptions,
} from "../../contracts/acpConnection.ts";
import type { HostService } from "../../contracts/host.ts";
import type { AcpTransport } from "../../contracts/acpTransport.ts";
import { AcpConnection } from "./AcpConnection.ts";
import { AcpConnectionPool } from "./AcpConnectionPool.ts";
import { createTauriStdioTransport } from "./protocol/transport/tauriStdioTransport.ts";

export class DesktopAcpConnection implements AcpConnectionService {
  private readonly connections = new Set<AcpConnectionPort>();
  private readonly releasing = new Map<AcpConnectionPort, Promise<void>>();
  private readonly pools = new Set<AcpConnectionPool>();
  private stopping?: Promise<void>;
  constructor(private readonly host: HostService) {}
  async createTransport(options: AcpTransportLaunchOptions): Promise<AcpTransport | null> {
    if (this.stopping) throw new Error("ACP base is stopping");
    return this.host.isNative()
      ? this.createNativeTransport(options)
      : this.host.openDevelopmentAcpTransport(options);
  }
  async createNativeTransport(
    options: AcpTransportLaunchOptions,
  ): Promise<AcpTransport> {
    if (this.stopping) throw new Error("ACP base is stopping");
    return createTauriStdioTransport(options, this.host.acpProcess);
  }
  createConnection(transport: AcpTransport, capacity: number): AcpConnection {
    if (this.stopping) throw new Error("ACP base is stopping");
    const connection = new AcpConnection(transport, capacity);
    this.connections.add(connection);
    return connection;
  }
  createPool(connect: () => Promise<AcpConnectionPort>): AcpConnectionPool {
    if (this.stopping) throw new Error("ACP base is stopping");
    const pool = new AcpConnectionPool(
      connect,
      (connection) => {
        this.connections.delete(connection);
      },
      () => {
        this.pools.delete(pool);
      },
    );
    this.pools.add(pool);
    return pool;
  }

  releaseConnection(connection: AcpConnectionPort, force = false): Promise<void> {
    if (!this.connections.has(connection)) return Promise.resolve();
    const pending = this.releasing.get(connection);
    if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      if (force) await connection.kill();
      else await connection.close().catch(() => connection.kill());
      this.connections.delete(connection);
    }).finally(() => this.releasing.delete(connection));
    this.releasing.set(connection, task);
    return task;
  }

  shutdown(): Promise<void> {
    return (this.stopping ??= (async () => {
      const poolResults = await Promise.allSettled(
        [...this.pools].map((pool) => pool.shutdown()),
      );
      const connectionResults = await Promise.allSettled(
        [...this.connections].map((connection) => this.releaseConnection(connection)),
      );
      this.pools.clear();
      this.connections.clear();
      const failures = [...poolResults, ...connectionResults].filter(
        (result) => result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          "ACP connection cleanup failed",
        );
    })());
  }
}
