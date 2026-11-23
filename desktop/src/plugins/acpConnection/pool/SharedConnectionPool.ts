import {
  ACP_CONNECTION_POOL_SIZE,
  type AcpChannelLease,
  type AcpChannelOptions,
  type AcpConnectionPoolPort,
  type AcpConnectionPort,
  type AcpSharedConnectionPoolPort,
} from "../types.ts";
import { AcpConnectionPool } from "./AcpConnectionPool.ts";
import { unconfirmedCleanup } from "../protocol/errors.ts";

type Configuration = {
  readonly key: string;
  readonly connect: () => Promise<AcpConnectionPort>;
};
type Slot = {
  readonly config: Configuration;
  readonly pool: AcpConnectionPool;
  readonly processRevision: number;
  users: number;
  isRetiring?: boolean;
  cleanup?: () => Promise<unknown>;
  failure?: Error;
};

function warmupFailure(errors: readonly unknown[]): Error | undefined {
  if (!errors.length) return undefined;
  const details = [
    ...new Set(
      errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ),
  ].join("; ");
  return new AggregateError(errors, `ACP connection warmup failed: ${details}`);
}

/** 单一物理额度的配置分区；占位早于启动，确认退出后才归还额度。 */
export class SharedConnectionPool implements AcpSharedConnectionPoolPort {
  private readonly slots: Slot[] = [];
  private readonly configs = new Map<string, Configuration>();
  private current: Configuration;
  private candidate?: { revision: number; config: Configuration };
  private revision = 0;
  private changed = 0;
  private readonly waiters = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private stopping?: Promise<void>;
  private isStopping = false;
  private failure?: Error;

  constructor(
    connect: () => Promise<AcpConnectionPort>,
    key: string,
    private readonly onClosed: () => void,
  ) {
    this.current = this.configuration(key, connect);
  }

  private configuration(
    key: string,
    connect: Configuration["connect"],
  ): Configuration {
    let config = this.configs.get(key);
    if (!config) {
      config = { key, connect };
      this.configs.set(key, config);
    }
    return config;
  }

  private notify(): void {
    this.changed++;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private wait(version: number): Promise<void> {
    if (version !== this.changed || this.isStopping) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.serial.then(() => {
      if (this.isStopping) throw new Error("ACP pool is stopping");
      return run();
    });
    this.serial = task.catch(() => {});
    return task;
  }

  private async remove(slot: Slot): Promise<void> {
    // 回收失败的进程继续占额度，不能以删除数组元素的方式假装已退出。
    slot.isRetiring = true;
    await slot.cleanup?.();
    await slot.pool.shutdown();
    this.slots.splice(this.slots.indexOf(slot), 1);
    this.notify();
  }

  private async create(
    config: Configuration,
    processRevision = 0,
  ): Promise<Slot> {
    const slot: Slot = {
      config,
      processRevision,
      pool: new AcpConnectionPool(config.connect, undefined, undefined, 1),
      users: 0,
    };
    this.slots.push(slot);
    try {
      await slot.pool.ensureAvailable();
      return slot;
    } catch (error) {
      const cleanup = unconfirmedCleanup(error);
      if (cleanup) {
        slot.cleanup = cleanup;
        slot.failure =
          error instanceof Error ? error : new Error(String(error));
      } else await this.remove(slot);
      throw error;
    }
  }

  private async available(
    config: Configuration,
    evict: boolean,
    minimumProcessRevision = 0,
  ): Promise<Slot | undefined> {
    const matches = this.slots.filter(
      (slot) =>
        slot.config === config &&
        slot.processRevision >= minimumProcessRevision,
    );
    const ready = this.readySlots(config, minimumProcessRevision).sort(
      (a, b) => a.users - b.users,
    )[0];
    if (ready) return ready;
    // 故障槽的替换也必须先确认旧进程终止，由单槽池负责恢复。
    if (matches[0]) {
      if (matches[0].failure) throw matches[0].failure;
      await matches[0].pool.ensureAvailable();
      return matches[0];
    }
    if (this.slots.length >= ACP_CONNECTION_POOL_SIZE && evict) {
      const idle = this.slots.find(
        (slot) => slot.users === 0 && slot.config !== this.candidate?.config,
      );
      if (idle) await this.remove(idle);
    }
    if (this.slots.length >= ACP_CONNECTION_POOL_SIZE) return undefined;
    return this.create(config, minimumProcessRevision);
  }

  private async ensure(config: Configuration): Promise<void> {
    if (this.isStopping) throw new Error("ACP pool is stopping");
    if (this.readySlots(config).length) return;
    for (;;) {
      const version = this.changed;
      if (await this.enqueue(() => this.available(config, true))) return;
      await this.wait(version);
    }
  }

  private async fill(config: Configuration): Promise<void> {
    if (this.isStopping) throw new Error("ACP pool is stopping");
    // 健康分区无需等待其他 Agent 的握手，也不能预留第五个槽。
    if (
      this.slots.length >= ACP_CONNECTION_POOL_SIZE &&
      this.readySlots(config).length
    )
      return;
    const initialized = await this.enqueue(async () => {
      if (this.slots.length !== 0) return false;
      const results = await Promise.allSettled(
        Array.from({ length: ACP_CONNECTION_POOL_SIZE }, () =>
          this.create(config),
        ),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      this.failure = warmupFailure(errors);
      if (this.slots.every((slot) => slot.pool.size === 0) && this.failure)
        throw this.failure;
      return true;
    });
    if (initialized) return;
    await this.ensure(config);
    await this.enqueue(async () => {
      const count = ACP_CONNECTION_POOL_SIZE - this.slots.length;
      const results = await Promise.allSettled(
        Array.from({ length: count }, () => this.create(config)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      this.failure = warmupFailure(errors);
    });
  }

  private lease(
    config: Configuration,
    options?: AcpChannelOptions,
  ): AcpChannelLease {
    const slot = this.readySlots(config, options?.minimumProcessRevision).sort(
      (a, b) =>
        b.processRevision - a.processRevision ||
        a.pool.runningRequests - b.pool.runningRequests ||
        a.users - b.users,
    )[0];
    if (this.isStopping) throw new Error("ACP pool is stopping");
    if (!slot) throw new Error("No ready ACP connection");
    const lease = slot.pool.openChannel(options);
    slot.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.users--;
      this.notify();
      if (
        slot.users === 0 &&
        slot.config !== this.current &&
        slot.config !== this.candidate?.config
      ) {
        void this.enqueue(async () => {
          if (
            slot.users === 0 &&
            slot.config !== this.current &&
            slot.config !== this.candidate?.config &&
            this.slots.includes(slot)
          )
            await this.remove(slot);
        }).catch(() => {
          /* 未确认回收的槽继续占用额度。 */
        });
      }
    };
    return {
      ...lease,
      processRevision: slot.processRevision,
      close: () => {
        lease.close();
        release();
      },
      release: async (closeRemote) => {
        try {
          await lease.release(closeRemote);
        } finally {
          release();
        }
      },
      recover: async () => {
        try {
          await lease.recover();
        } finally {
          release();
        }
      },
    };
  }

  private async acquire(
    config: Configuration,
    options?: AcpChannelOptions,
  ): Promise<AcpChannelLease> {
    const minimum = options?.minimumProcessRevision;
    if (this.readySlots(config, minimum).length)
      return this.lease(config, options);
    for (;;) {
      const version = this.changed;
      const lease = await this.enqueue(async () => {
        if (!(await this.available(config, true, minimum))) return undefined;
        return this.lease(config, options);
      });
      if (lease) return lease;
      if (minimum)
        throw new Error(
          "新配置需要新的 ACP 进程，当前连接均在使用中，请稍后重试",
        );
      await this.wait(version);
    }
  }

  scope(key: string, connect: Configuration["connect"]): AcpConnectionPoolPort {
    const config = this.configuration(key, connect);
    const size = () =>
      this.readySlots(config).reduce((sum, slot) => sum + slot.pool.size, 0);
    const recoveryError = () => this.recoveryError;
    return {
      get size() {
        return size();
      },
      get recoveryError() {
        return recoveryError();
      },
      ensureAvailable: () => this.ensure(config),
      warm: () => this.fill(config),
      openChannel: (options) => this.lease(config, options),
      acquireChannel: (options) => this.acquire(config, options),
      prepareSwitch: (factory) => this.prepareSwitch(factory),
      abortSwitch: (revision) => this.abortSwitch(revision),
      commitSwitch: (revision) => this.commitSwitch(revision),
      // 分区不拥有物理进程，只有根所有者可以退出整支连接队伍。
      shutdown: () => Promise.resolve(),
    };
  }

  private readySlots(
    config: Configuration,
    minimumProcessRevision = 0,
  ): Slot[] {
    return this.slots.filter(
      (slot) =>
        slot.config === config &&
        slot.processRevision >= minimumProcessRevision &&
        !slot.isRetiring &&
        slot.pool.size > 0,
    );
  }

  selectConfiguration(key: string): void {
    const config = this.configs.get(key);
    if (!config || this.isStopping)
      throw new Error("ACP configuration is unavailable");
    this.current = config;
  }

  get size(): number {
    return this.slots.reduce((sum, slot) => sum + slot.pool.size, 0);
  }
  get recoveryError(): unknown {
    return (
      this.failure ??
      this.slots.find((slot) => slot.pool.recoveryError)?.pool.recoveryError
    );
  }
  ensureAvailable(): Promise<void> {
    return this.ensure(this.current);
  }
  warm(): Promise<void> {
    return this.fill(this.current);
  }
  openChannel(options?: AcpChannelOptions): AcpChannelLease {
    return this.lease(this.current, options);
  }
  acquireChannel(options?: AcpChannelOptions): Promise<AcpChannelLease> {
    return this.acquire(this.current, options);
  }

  prepareSwitch(connect: Configuration["connect"]): Promise<number> {
    return this.prepareConfiguration(`switch:${this.revision + 1}`, connect);
  }

  async prepareConfiguration(
    key: string,
    connect: Configuration["connect"],
  ): Promise<number> {
    const revision = ++this.revision;
    const config = this.configuration(key, connect);
    this.candidate = { revision, config };
    try {
      await this.enqueue(async () => {
        // 全部租约被占用时延后建连，提交阶段释放普通会话后再准备目标。
        // 不能为了预热第五条连接，也不能中断正在运行的定时任务。
        await this.available(config, true);
      });
    } catch (error) {
      if (this.candidate?.revision === revision) this.candidate = undefined;
      await this.fill(this.current).catch(() => {});
      throw error;
    }
    return revision;
  }

  async abortSwitch(revision: number): Promise<void> {
    if (this.candidate?.revision !== revision) return;
    const { config } = this.candidate;
    this.candidate = undefined;
    await this.enqueue(async () => {
      for (const slot of [...this.slots])
        if (
          slot.config === config &&
          slot.config !== this.current &&
          slot.users === 0
        )
          await this.remove(slot);
    });
  }

  async commitSwitch(revision: number): Promise<void> {
    const candidate = this.candidate;
    if (candidate?.revision !== revision)
      throw new Error("ACP switch is not ready or is superseded");
    await this.ensure(candidate.config);
    await this.enqueue(async () => {
      if (this.candidate !== candidate)
        throw new Error("ACP switch superseded");
      this.current = candidate.config;
      this.candidate = undefined;
      for (const slot of [...this.slots])
        if (slot.config !== this.current && slot.users === 0)
          await this.remove(slot);
    });
    await this.fill(candidate.config);
  }

  shutdown(options?: { force?: boolean }): Promise<void> {
    if (this.stopping) return this.stopping;
    this.isStopping = true;
    this.notify();
    this.stopping = this.serial.then(async () => {
      const results = await Promise.allSettled(
        this.slots.map(async (slot) => {
          await slot.cleanup?.();
          await slot.pool.shutdown(options);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "ACP shared pool shutdown failed");
      this.slots.length = 0;
      this.onClosed();
    });
    const task = this.stopping;
    void task.catch(() => {
      if (this.stopping === task) this.stopping = undefined;
    });
    return this.stopping;
  }
}
