/**
 * 结构化日志 + 环形缓冲（src/core 可观测设施）。
 *
 * 设计目标：
 * - 诊断页（未来 src/ui 的 Diagnostics 面板）读取的唯一真相源是环形缓冲，
 *   UI 只订阅快照，不自己 accumulate 状态；
 * - `acpTraffic` 是独立于业务日志的 ACP wire 流量通道：每条读写 JSON-RPC
 *   消息按方向（in/out）、类别（request/response/notification）归档，
 *   供「协议层不动、未来接第二种 agent」时做线上对拍；
 * - 全程无 any：外部数据（ACP payload 等）一律以 unknown 进入，
 *   序列化失败降级为 serializeError 文本，绝不抛出影响调用方。
 */

/** 日志级别，数值越高越严重（见 LOG_LEVEL_ORDER）。 */
import { redactContext, redactText } from "./logPrivacy.ts";
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LOG_RING_CAPACITY = 2000;
const DEFAULT_ACP_TRAFFIC_CAPACITY = 1000;
/** 单条 ACP wire 消息序列化后的截断上限，防止超长 payload 撑爆内存。 */
const ACP_PAYLOAD_MAX_CHARS = 16 * 1024;

/** 一条结构化日志。context 里只放可 JSON 序列化的原始值。 */
export interface LogEntry {
  /** 单调递增序号，诊断页据此稳定排序与去重。 */
  readonly seq: number;
  /** ISO 8601 时间戳。 */
  readonly timestamp: string;
  readonly level: LogLevel;
  /** 日志通道：app / acp / aaw / store / settings 等。 */
  readonly channel: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/** 一条 ACP wire 流量记录。 */
export interface AcpTrafficEntry {
  readonly seq: number;
  readonly timestamp: string;
  /** in = 从 agent 收到；out = 发给 agent。 */
  readonly direction: "in" | "out";
  readonly kind: "request" | "response" | "notification";
  /** request/notification 的 method；response 为 null。 */
  readonly method: string | null;
  /** JSON-RPC id；无 id（notification）为 null。 */
  readonly requestId: number | string | null;
  /** 序列化（并可能截断）后的 JSON 文本。 */
  readonly payload: string;
  /** 序列化后正文的 UTF-8 字节数（截断后）。 */
  readonly byteLength: number;
  /** 序列化失败时的原因说明；成功时为 undefined。 */
  readonly serializeError?: string;
}

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

/** 安全序列化：容忍循环引用与不可序列化值，超长截断。 */
function safeStringify(
  value: unknown,
  maxChars: number,
): {
  text: string;
  serializeError?: string;
} {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, current: unknown): unknown => {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }
    return current;
  };
  try {
    const text = JSON.stringify(value, replacer);
    if (text === undefined) {
      // undefined / function 等无法序列化的顶层值
      return { text: String(value), serializeError: "不可 JSON 序列化" };
    }
    if (text.length > maxChars) {
      return {
        text: `${text.slice(0, maxChars)}…[已截断，原长 ${text.length}]`,
      };
    }
    return { text };
  } catch (error) {
    return {
      text: String(value),
      serializeError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 全局单调序号，日志与流量共用，保证诊断页排序稳定。 */
let globalSeq = 0;
function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** 日志汇聚点：级别过滤 + 环形缓冲 + console 镜像。 */
export class LogSink {
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
  ): void {
    if (LOG_LEVEL_ORDER[level] < this.levelValue) {
      return;
    }
    const entry: LogEntry = {
      seq: nextSeq(),
      timestamp: new Date().toISOString(),
      level,
      channel,
      message: redactText(message),
      context: (redactContext(context ?? {}) ?? {}) as Readonly<
        Record<string, unknown>
      >,
    };
    this.ring.push(entry);
    for (const listener of this.entryListeners) listener(entry);
    mirrorToConsole(entry);
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

/** 带通道名与绑定上下文的日志器；由 createLogger 创建，不直接 new。 */
export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly channel: string,
    private readonly boundContext: Readonly<Record<string, unknown>> = {},
  ) {}

  /** 派生一个追加绑定上下文的子 logger（如 requestId 固定的会话）。 */
  child(context: Readonly<Record<string, unknown>>): Logger {
    return new Logger(this.sink, this.channel, {
      ...this.boundContext,
      ...context,
    });
  }

  debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write("error", message, context);
  }

  private write(
    level: LogLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.sink.log(level, this.channel, message, {
      ...this.boundContext,
      ...context,
    });
  }
}

/**
 * console 镜像：桌面 app 的 devtools 里直接可读。
 *
 * vitest（import.meta.env.MODE === "test"）下不镜像：测试断言走环形缓冲，
 * 预期内的 warn/error（失败路径用例）不再污染测试 stderr；
 * 环形缓冲与诊断页行为不受影响。
 */
function mirrorToConsole(entry: LogEntry): void {
  if (import.meta.env?.MODE === "test") {
    return;
  }
  const time = entry.timestamp.slice(11, 23);
  const contextText =
    Object.keys(entry.context).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : "";
  const line = `[${time}] [${entry.channel}] ${entry.message}${contextText}`;
  switch (entry.level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

// ---------------------------------------------------------------------------
// 默认 sink 与 acpTraffic 通道
// ---------------------------------------------------------------------------

/** 应用级默认日志汇聚点：诊断页读取的就是它。 */
export const appLogSink = new LogSink(DEFAULT_LOG_RING_CAPACITY, "debug");

/** 便捷工厂：从默认 sink 派生带通道的 logger。 */
export function createLogger(
  channel: string,
  context?: Readonly<Record<string, unknown>>,
): Logger {
  return new Logger(appLogSink, channel, context);
}

/** ACP wire 流量通道：独立环形缓冲，容量与业务日志分开配。 */
export interface AcpTrafficChannel {
  recordOut(payload: unknown): void;
  recordIn(payload: unknown): void;
  snapshot(): readonly AcpTrafficEntry[];
  subscribe(listener: SnapshotListener<AcpTrafficEntry>): () => void;
  clear(): void;
  readonly capacity: number;
}

export function createAcpTrafficChannel(
  capacity: number = DEFAULT_ACP_TRAFFIC_CAPACITY,
): AcpTrafficChannel {
  const ring = new RingBuffer<AcpTrafficEntry>(capacity);

  function classify(payload: unknown): {
    kind: AcpTrafficEntry["kind"];
    method: string | null;
    requestId: number | string | null;
  } {
    if (typeof payload !== "object" || payload === null) {
      return { kind: "notification", method: null, requestId: null };
    }
    const record = payload as Readonly<Record<string, unknown>>;
    const id = record["id"];
    const method = record["method"];
    const requestId =
      typeof id === "number" || typeof id === "string" ? id : null;
    if (typeof method === "string") {
      return {
        kind: requestId === null ? "notification" : "request",
        method,
        requestId,
      };
    }
    return { kind: "response", method: null, requestId };
  }

  function record(direction: "in" | "out", payload: unknown): void {
    const { text, serializeError } = safeStringify(
      payload,
      ACP_PAYLOAD_MAX_CHARS,
    );
    const { kind, method, requestId } = classify(payload);
    appLogSink.log("debug", "acp-traffic", "ACP 协议事件", {
      direction,
      kind,
      method,
      requestId,
    });
    const entry: AcpTrafficEntry = {
      seq: nextSeq(),
      timestamp: new Date().toISOString(),
      direction,
      kind,
      method,
      requestId,
      payload: text,
      byteLength: new TextEncoder().encode(text).length,
      ...(serializeError === undefined ? {} : { serializeError }),
    };
    ring.push(entry);
  }

  return {
    recordOut: (payload) => record("out", payload),
    recordIn: (payload) => record("in", payload),
    snapshot: () => ring.snapshot(),
    subscribe: (listener) => ring.subscribe(listener),
    clear: () => ring.clear(),
    capacity,
  };
}

/**
 * ACP 流量专用通道：协议层（src/acp）每写出一行、每读入一行，
 * 都要在此登记一次；诊断页据此还原完整 wire 时序。
 */
export const acpTraffic: AcpTrafficChannel = createAcpTrafficChannel();
