import type { AcpChannel, AcpChannelLease, AcpChannelOptions, AcpConnectionPoolPort, AcpConnectionPort } from "../../contracts/acpConnection.ts";

/** The factory returns an initialized connection for the selected Agent. */
export class AcpConnectionPool implements AcpConnectionPoolPort {
  private connections: AcpConnectionPort[] = [];
  private preparing?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly owners = new Set<AcpChannel>();
  private readonly observers = new Map<AcpConnectionPort, () => void>();
  private readonly retiring = new WeakMap<AcpConnectionPort, Promise<void>>();
  private repair?: Promise<void>;
  private repairFailure?: unknown;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private cancelRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  private scheduleRetry(): void {
    if (this.stopping || this.committing || this.retryTimer !== undefined)
      return;
    const delay = [1000, 3000, 10000][this.retryAttempt];
    if (delay === undefined) return;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.scheduleRepair();
    }, delay);
  }

  /** Foreground work may use healthy connections while missing slots retry. */
  async ensureAvailable(): Promise<void> {
    if (this.stopping || this.committing)
      throw new Error("ACP pool is changing or stopping");
    if (this.size > 0) return;
    try {
      await this.warm();
    } catch (error) {
      if (this.size === 0) throw error;
    }
  }
  private switchRevision = 0;
  private candidate?: {
    revision: number;
    pool: AcpConnectionPool;
    ready: boolean;
  };
  private committing?: Promise<void>;
  private readonly switchCleanup = new Set<Promise<void>>();

  /** Retained for callers to report failed background repair without unhandled rejection. */
  get recoveryError(): unknown {
    return this.repairFailure;
  }

  private scheduleRepair(): void {
    if (this.stopping || this.committing || this.repair) return;
    this.repair = Promise.resolve()
      .then(async () => {
        await this.preparing?.catch(() => {});
        if (!this.stopping) await this.warmAttempt();
      })
      .then(
        () => {
          this.repairFailure = undefined;
        },
        (error: unknown) => {
          this.repairFailure = error;
        },
      )
      .finally(() => {
        this.repair = undefined;
        if (
          !this.stopping &&
          !this.committing &&
          this.repairFailure === undefined &&
          this.size < 4
        )
          this.scheduleRepair();
      });
  }

  private retire(connection: AcpConnectionPort): Promise<void> {
    const existing = this.retiring.get(connection);
    if (existing) return existing;
    this.observers.get(connection)?.();
    this.observers.delete(connection);
    const task = connection.kill().then(() => {});
    this.retiring.set(connection, task);
    // Keep failed termination recorded: replacing an unconfirmed process is unsafe.
    return task;
  }

  constructor(
    private connect: () => Promise<AcpConnectionPort>,
    private readonly adopt: (connection: AcpConnectionPort) => void = () => {},
    private readonly onClosed: () => void = () => {},
  ) {}

  private discard(pool: AcpConnectionPool): Promise<void> {
    const task = pool.shutdown();
    this.switchCleanup.add(task);
    void task.then(
      () => this.switchCleanup.delete(task),
      () => {},
    );
    return task;
  }

  /** Prepare the target Agent while preserving the current Agent's connections. */
  async prepareSwitch(connect: () => Promise<AcpConnectionPort>): Promise<number> {
    if (this.stopping || this.committing)
      throw new Error("ACP pool is changing or stopping");
    const revision = ++this.switchRevision;
    const previous = this.candidate;
    const candidate = {
      revision,
      pool: new AcpConnectionPool(connect, this.adopt),
      ready: false,
    };
    this.candidate = candidate;
    try {
      if (previous) await this.discard(previous.pool);
      await Promise.all(this.switchCleanup);
      if (this.candidate !== candidate || this.stopping)
        throw new Error("ACP switch superseded");
      await candidate.pool.warm();
      if (this.candidate !== candidate || this.stopping)
        throw new Error("ACP switch superseded");
      candidate.ready = true;
      return revision;
    } catch (error) {
      if (this.candidate === candidate) this.candidate = undefined;
      await this.discard(candidate.pool);
      throw error;
    }
  }

  async abortSwitch(revision: number): Promise<void> {
    if (this.committing) throw new Error("ACP switch is committing");
    if (this.candidate?.revision !== revision) return;
    const candidate = this.candidate;
    this.candidate = undefined;
    await this.discard(candidate.pool);
  }

  /** Business layer must freeze/cancel old sessions before committing. */
  commitSwitch(revision: number): Promise<void> {
    const candidate = this.candidate;
    if (
      this.stopping ||
      this.committing ||
      candidate?.revision !== revision ||
      !candidate.ready
    )
      return Promise.reject(
        new Error("ACP switch is not ready or is superseded"),
      );
    this.cancelRetry();
    candidate.pool.cancelRetry();
    const task = Promise.resolve().then(async () => {
      await this.preparing?.catch(() => {});
      await this.repair;
      await candidate.pool.preparing;
      await candidate.pool.repair;
      if (candidate.pool.size !== 4)
        throw new Error("Prepared ACP connections are no longer ready");
      const results = await Promise.allSettled(
        this.connections.map((connection) => this.retire(connection)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Old ACP connections did not stop");
      if (this.stopping) throw new Error("ACP pool is stopping");
      await candidate.pool.preparing;
      await candidate.pool.repair;
      if (candidate.pool.size !== 4)
        throw new Error("Prepared ACP connections are no longer ready");
      for (const detach of candidate.pool.observers.values()) detach();
      candidate.pool.observers.clear();
      this.connections = candidate.pool.connections;
      candidate.pool.connections = [];
      this.connect = candidate.pool.connect;
      this.retryAttempt = 0;
      this.repairFailure = undefined;
      this.owners.clear();
      for (const connection of this.connections)
        this.observers.set(
          connection,
          connection.onUnavailable(() => this.scheduleRepair()),
        );
      this.candidate = undefined;
      await this.discard(candidate.pool);
    });
    this.committing = task;
    void task
      .finally(() => {
        if (this.committing === task) this.committing = undefined;
      })
      .catch(() => {});
    return task;
  }

  get size(): number {
    return this.connections.filter((connection) => connection.available).length;
  }

  /** Occupied connections count toward the four; concurrent callers share work. */
  warm(): Promise<void> {
    this.retryAttempt = 0;
    return this.warmAttempt();
  }

  private warmAttempt(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("ACP pool is stopping"));
    if (this.committing)
      return Promise.reject(new Error("ACP switch is committing"));
    if (this.preparing) return this.preparing;
    this.cancelRetry();
    const task = this.fill();
    this.preparing = task;
    void task.then(
      () => {
        if (this.preparing === task) this.preparing = undefined;
        this.retryAttempt = 0;
        this.repairFailure = undefined;
      },
      (error: unknown) => {
        if (this.preparing === task) this.preparing = undefined;
        this.repairFailure = error;
        this.scheduleRetry();
      },
    );
    return task;
  }

  private async fill(): Promise<void> {
    const retired = this.connections.filter(
      (connection) => !connection.available,
    );
    // Confirm termination before replacing an uncertain remote process.
    await Promise.all(retired.map((connection) => this.retire(connection)));
    this.connections = this.connections.filter(
      (connection) => !retired.includes(connection),
    );
    if (this.stopping) return;
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.max(0, 4 - this.connections.length) },
        async () => {
          const connection = await this.connect();
          this.adopt(connection);
          if (this.stopping) {
            await connection.close();
            return;
          }
          if (!connection.available) {
            await connection.kill();
            throw new Error("Prepared ACP connection is unavailable");
          }
          this.connections.push(connection);
          this.observers.set(
            connection,
            connection.onUnavailable(() => this.scheduleRepair()),
          );
        },
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        `ACP connection warmup failed: ${[...new Set(errors.map((error) => (error instanceof Error ? error.message : String(error))))].join("; ")}`,
      );
    this.repairFailure = undefined;
  }

  openChannel(options: AcpChannelOptions = {}): AcpChannelLease {
    if (this.stopping) throw new Error("ACP pool is stopping");
    if (this.committing) throw new Error("ACP switch is committing");
    const connection = this.connections
      .filter((item) => item.available)
      .sort(
        (a, b) =>
          a.runningRequests - b.runningRequests ||
          a.boundSessions - b.boundSessions,
      )[0];
    if (!connection) throw new Error("No ready ACP connection");
    const channel = connection.openChannel(options);
    this.owners.add(channel);
    return {
      ...channel,
      escalate: async () => {
        await this.retire(connection);
        if (!this.stopping) await this.warm();
      },
      promote: () => {
        if (!this.owners.has(channel))
          throw new Error("Session does not belong to this pool");
        channel.promote();
      },
      release: async (closeRemote) => {
        if (!this.owners.has(channel)) return;
        try {
          await closeRemote();
        } catch {
          // 远端释放未确认时由连接所有者回收整个进程。
          await this.retire(connection);
          this.scheduleRepair();
        } finally {
          this.owners.delete(channel);
        }
      },
      recover: async () => {
        if (this.owners.has(channel)) {
          await this.retire(connection);
          this.owners.delete(channel);
        }
        if (!this.stopping) this.scheduleRepair();
      },
    };
  }

  shutdown(options: { force?: boolean } = {}): Promise<void> {
    this.cancelRetry();
    return (this.stopping ??= Promise.resolve().then(async () => {
      await this.committing?.catch(() => {});
      if (this.candidate) {
        const candidate = this.candidate;
        this.candidate = undefined;
        void this.discard(candidate.pool).catch(() => {});
      }
      await this.preparing?.catch(() => {});
      await this.repair;
      for (const detach of this.observers.values()) detach();
      this.observers.clear();
      const results = await Promise.allSettled([
        ...this.connections.map((connection) =>
          options.force ? connection.kill() : connection.close(),
        ),
        ...this.switchCleanup,
      ]);
      this.connections = [];
      this.owners.clear();
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "ACP pool shutdown failed");
      this.onClosed();
    }));
  }
}
