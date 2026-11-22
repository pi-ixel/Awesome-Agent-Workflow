import type { AcpConnectionPort } from "../types.ts";
import type { AcpDiagnosticPrivacy } from "../../../contracts/acp/diagnosticPrivacy.ts";
import { ACP_CONNECTION_POOL_SIZE } from "../types.ts";
import type { AcpConnectionService } from "../service.ts";
import type { HostService } from "../../host/service.ts";
import type { JsonRpcConnectionOptions } from "../protocol/JsonRpcConnection.ts";
import type {
  AcpTransport,
  AcpTransportLaunchOptions,
} from "../../host/types.ts";
import { AcpConnection } from "../channels/AcpConnection.ts";
import { SharedConnectionPool } from "../pool/SharedConnectionPool.ts";
import { createTauriStdioTransport } from "../protocol/transport/tauriStdioTransport.ts";
import { AcpClosedError } from "../protocol/errors.ts";
import { budgetedTransport } from "./budgetedTransport.ts";

export class DesktopAcpConnection implements AcpConnectionService {
  private readonly connections = new Set<AcpConnection>();
  private readonly releasing = new Map<AcpConnectionPort, Promise<void>>();
  private readonly pools = new Set<SharedConnectionPool>();
  private readonly transports = new Set<AcpTransport>();
  private readonly diagnosticTransports = new Set<AcpTransport>();
  private readonly unbudgeted = new Set<AcpConnection>();
  private readonly starting = new Set<Promise<AcpTransport | null>>();
  private opening = 0;
  private isDiagnosticOpening = false;
  private stopping?: Promise<void>;
  constructor(
    private readonly host: HostService,
    private readonly logging: Pick<
      JsonRpcConnectionOptions,
      "logger" | "recordRaw"
    >,
  ) {}
  diagnostics() {
    return [...this.connections].map(
      (connection) => connection.diagnosticSnapshot,
    );
  }
  probe(id: string) {
    const connection = [...this.connections].find(
      (item) => item.diagnosticSnapshot.id === id,
    );
    return connection
      ? connection.probe()
      : Promise.resolve({ at: Date.now(), status: "unavailable" as const });
  }
  async createTransport(
    options: AcpTransportLaunchOptions,
    purpose?: "diagnostic",
  ): Promise<AcpTransport | null> {
    if (this.stopping) throw new Error("ACP base is stopping");
    const isDiagnostic = purpose === "diagnostic";
    const transports = isDiagnostic
      ? this.diagnosticTransports
      : this.transports;
    if (isDiagnostic) {
      if (this.isDiagnosticOpening || transports.size > 0)
        throw new Error("ACP 诊断连接正在使用或尚未退出，请稍后重试");
      this.isDiagnosticOpening = true;
    } else {
      if (this.physicalCount >= ACP_CONNECTION_POOL_SIZE)
      throw new Error(
        "ACP 连接额度已满（最多 4 条），请等待运行中的会话结束后重试",
      );
      this.opening++;
    }
    const task = Promise.resolve()
      .then(async () => {
        const raw = this.host.isNative()
          ? await createTauriStdioTransport(options, this.host.acpProcess)
          : await this.host.openDevelopmentAcpTransport(options);
        if (!raw) return null;
        const binding: { transport?: AcpTransport } = {};
        const transport = budgetedTransport(raw, () => {
          if (binding.transport) transports.delete(binding.transport);
        });
        binding.transport = transport;
        if (!transport.isClosed) transports.add(transport);
        if (this.stopping) {
          await transport.kill();
          await transport.dispose?.();
          throw new Error("ACP base is stopping");
        }
        return transport;
      })
      .finally(() => {
        if (isDiagnostic) this.isDiagnosticOpening = false;
        else this.opening--;
        this.starting.delete(task);
      });
    this.starting.add(task);
    return task;
  }

  private get physicalCount(): number {
    return this.transports.size + this.unbudgeted.size + this.opening;
  }
  createConnection(transport: AcpTransport, capacity: number, diagnosticPrivacy?: AcpDiagnosticPrivacy): AcpConnection {
    if (this.stopping) throw new Error("ACP base is stopping");
    if (transport.isClosed) throw new AcpClosedError("ACP 进程已退出");
    const isBudgeted =
      this.transports.has(transport) ||
      this.diagnosticTransports.has(transport);
    if (!isBudgeted && this.physicalCount >= ACP_CONNECTION_POOL_SIZE)
      throw new Error("ACP 连接额度已满（最多 4 条）");
    const connection = new AcpConnection(
      transport,
      capacity,
      { ...this.logging, diagnosticPrivacy },
      () => {
        this.connections.delete(connection);
        this.unbudgeted.delete(connection);
      },
    );
    this.connections.add(connection);
    if (!isBudgeted) this.unbudgeted.add(connection);
    return connection;
  }
  createPool(
    connect: () => Promise<AcpConnectionPort>,
    key = "default",
  ): SharedConnectionPool {
    if (this.stopping) throw new Error("ACP base is stopping");
    if (this.pools.size > 0)
      throw new Error("Desktop 只能拥有一个共享 ACP 连接池");
    const pool = new SharedConnectionPool(connect, key, () => {
      this.pools.delete(pool);
    });
    this.pools.add(pool);
    return pool;
  }

  releaseConnection(
    connection: AcpConnectionPort,
    force = false,
  ): Promise<void> {
    if (
      !(connection instanceof AcpConnection) ||
      !this.connections.has(connection)
    )
      return Promise.resolve();
    const pending = this.releasing.get(connection);
    if (pending) return pending;
    const task = Promise.resolve()
      .then(async () => {
        if (force) await connection.kill();
        else await connection.close().catch(() => connection.kill());
        this.connections.delete(connection);
      })
      .finally(() => this.releasing.delete(connection));
    this.releasing.set(connection, task);
    return task;
  }

  shutdown(): Promise<void> {
    return (this.stopping ??= (async () => {
      const poolResults = await Promise.allSettled(
        [...this.pools].map((pool) => pool.shutdown()),
      );
      await Promise.allSettled([...this.starting]);
      const connectionResults = await Promise.allSettled(
        [...this.connections].map((connection) =>
          this.releaseConnection(connection),
        ),
      );
      const transportResults = await Promise.allSettled(
        [...this.transports, ...this.diagnosticTransports].map(
          async (transport) => {
            await transport.kill();
            await transport.dispose?.();
          },
        ),
      );
      this.pools.clear();
      this.connections.clear();
      const failures = [
        ...poolResults,
        ...connectionResults,
        ...transportResults,
      ].filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          "ACP connection cleanup failed",
        );
    })());
  }
}
