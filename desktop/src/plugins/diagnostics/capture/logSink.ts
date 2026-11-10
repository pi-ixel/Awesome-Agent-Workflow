import { createLogEntry, mirrorToConsole, Logger, type LoggerFactory } from "../../../shared/logging/logger.ts";
import type { LogEntry, LogLevel } from "../../../shared/logging/types.ts";

const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LOG_RING_CAPACITY = 2000;

type SnapshotListener<T> = (snapshot: readonly T[]) => void;

/**
 * 定长环形缓冲：写满覆盖最旧条目。
 * 诊断页通过 subscribe 拿最新快照；snapshot() 始终按写入顺序返回。
 */
export class RingBuffer<T> {
  // readonly 字段：引用不变；数组元素可写（环形缓冲的本职）
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private count = 0;
  private readonly listeners = new Set<SnapshotListener<T>>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `RingBuffer 容量必须为正整数，收到：${String(capacity)}`,
      );
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  /** 当前有效条数（≤ capacity）。 */
  get size(): number {
    return this.count;
  }

  push(item: T): void {
    this.slots[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
    // 拷贝后遍历，允许 listener 内安全 unsubscribe
    for (const listener of [...this.listeners]) {
      listener(this.snapshot());
    }
  }

  /** 按写入顺序返回当前缓冲内容的浅拷贝。 */
  snapshot(): readonly T[] {
    const out: T[] = [];
    // 缓冲未写满时从 0 开始；写满后 head 即最旧条目位置
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i += 1) {
      const slot = this.slots[(start + i) % this.capacity];
      // count 只统计已写入槽位，正常不会读到 undefined；守卫仅满足类型收窄
      if (slot !== undefined) {
        out.push(slot);
      }
    }
    return out;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
    for (const listener of [...this.listeners]) {
      listener(this.snapshot());
    }
  }

  /** 订阅缓冲变化（push / clear 均通知），返回退订函数。 */
  subscribe(listener: SnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 日志汇聚点：级别过滤 + 环形缓冲 + console 镜像。 */
export class LogSink {
  private sequence = 0;
  readonly createLogger: LoggerFactory = (channel, context) =>
    new Logger(this, channel, context);

  private readonly entryListeners = new Set<(entry: LogEntry) => void>();
  subscribeEntry(listener: (entry: LogEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }
  private levelValue: number;
  private readonly ring: RingBuffer<LogEntry>;

  constructor(
    readonly ringCapacity: number = DEFAULT_LOG_RING_CAPACITY,
    level: LogLevel = "info",
  ) {
    this.ring = new RingBuffer<LogEntry>(ringCapacity);
    this.levelValue = LOG_LEVEL_ORDER[level];
  }

  get level(): LogLevel {
    // 反查：级别表小，遍历开销可忽略
    for (const [name, value] of Object.entries(LOG_LEVEL_ORDER)) {
      if (value === this.levelValue) {
        return name as LogLevel;
      }
    }
    return "info";
  }

  setLevel(level: LogLevel): void {
    this.levelValue = LOG_LEVEL_ORDER[level];
    this.log("info", "core", `日志级别已切换为 ${level}`);
  }

  log(
    level: LogLevel,
    channel: string,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): LogEntry | undefined {
    if (LOG_LEVEL_ORDER[level] < this.levelValue) {
      return;
    }
    const entry = createLogEntry(++this.sequence, level, channel, message, context);
    this.ring.push(entry);
    for (const listener of this.entryListeners) listener(entry);
    mirrorToConsole(entry);
    return entry;
  }

  snapshot(): readonly LogEntry[] {
    return this.ring.snapshot();
  }

  subscribe(listener: SnapshotListener<LogEntry>): () => void {
    return this.ring.subscribe(listener);
  }

  clear(): void {
    this.ring.clear();
  }
}
