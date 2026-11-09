import { Service, type Context } from "cordis";
import type { AcpTransport } from "./protocol/transport/acpTransport.ts";
import { AcpConnection } from "./AcpConnection.ts";
import { AcpConnectionPool } from "./AcpConnectionPool.ts";
import type { AcpBaseService } from "./service.ts";

export class AcpBasePlugin extends Service implements AcpBaseService {
  private readonly connections = new Set<AcpConnection>();
  private readonly pools = new Set<AcpConnectionPool>();
  private stopping?: Promise<void>;
  constructor(ctx: Context) {
    super(ctx, "acpBase");
    ctx.effect(() => () => this.shutdown());
  }
  createConnection(transport: AcpTransport, capacity: number): AcpConnection {
    if (this.stopping) throw new Error("ACP base is stopping");
    const connection = new AcpConnection(transport, capacity);
    this.connections.add(connection);
    return connection;
  }
  createPool(connect: () => Promise<AcpConnection>): AcpConnectionPool {
    if (this.stopping) throw new Error("ACP base is stopping");
    const pool = new AcpConnectionPool(connect, (connection) => {
      this.connections.delete(connection);
    });
    this.pools.add(pool);
    return pool;
  }
  shutdown(): Promise<void> {
    return (this.stopping ??= (async () => {
      const poolResults = await Promise.allSettled(
        [...this.pools].map((pool) => pool.shutdown()),
      );
      const connectionResults = await Promise.allSettled(
        [...this.connections].map((connection) => connection.close()),
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
