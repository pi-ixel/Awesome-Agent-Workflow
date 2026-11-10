import type { PtyNativeHost, PtySpawnOptions, PtyOutputWire, PtyExitWire } from "../../host/types.ts";
import type { PtyConnection } from "../types.ts";
import { createLogger } from "../../../shared/logging/logger.ts";


/** One routing table and native listener pair per terminal service. */
export function createPtyManager(
  host: PtyNativeHost,
  isExiting: () => boolean,
  logger = createLogger("pty"),
) {
  let disposed = false;
  const handles = new Set<number>();
  const closing = new Map<number, Promise<void>>();
  const openings = new Set<Promise<PtyConnection>>();
  /** 单连接的路由回调（host 单例监听 → 按 handle 分发的目标形态）。 */
  interface PtyRoute {
    onData(bytes: Uint8Array): void;
    onExit(code: number | null): void;
  }

  /** handle → 路由回调（事件分发的唯一真相）。 */
  const routes = new Map<number, PtyRoute>();
  /** handle → 连接对象（adopt / close 的查找表）。 */
  const connections = new Map<number, PtyConnection>();

  /** 订阅前到达的事件（handle 未注册），连接创建后回放。 */
  const early: Array<{
    readonly kind: "output" | "exit";
    readonly payload: PtyOutputWire | PtyExitWire;
  }> = [];

  /**
   * early 缓冲上限：永不认领的 handle 事件（closeConnection 摘路由后的尾部
   * 输出与合成 exit、注册失败路径的 exit）会在此永久滞留——按条数与
   * base64 字节数双封顶，丢最旧（这些事件本就无人认领，丢弃无副作用）。
   */
  const EARLY_LIMIT_ENTRIES = 256;
  const EARLY_LIMIT_BASE64_BYTES = 256 * 1024;

  function earlyBase64Bytes(): number {
    let total = 0;
    for (const item of early) {
      if (item.kind === "output") {
        total += (item.payload as PtyOutputWire).data.length;
      }
    }
    return total;
  }

  /** 入队 + 封顶（丢最旧）。 */
  function pushEarly(item: (typeof early)[number]): void {
    early.push(item);
    let entries = early.length;
    let bytes = earlyBase64Bytes();
    while (entries > EARLY_LIMIT_ENTRIES || bytes > EARLY_LIMIT_BASE64_BYTES) {
      const dropped = early.shift();
      if (dropped === undefined) {
        break;
      }
      entries -= 1;
      if (dropped.kind === "output") {
        bytes -= (dropped.payload as PtyOutputWire).data.length;
      }
    }
  }

  /** 仅供测试：early 缓冲当前条数（封顶行为断言用，非公开 API）。 */
  function earlyCountForTest(): number {
    return early.length;
  }

  const unlisteners: Array<() => void> = [];
  let listenersReady: Promise<void> | null = null;

  /** Listen before spawning so that early output can be replayed. */
  function ensureListeners(): Promise<void> {
    if (!listenersReady) {
      listenersReady = (async () => {
        const listen = async (register: () => Promise<() => void>) => {
          const stop = await register();
          if (disposed) {
            stop();
            throw new Error("Terminal service is disposed");
          }
          unlisteners.push(stop);
        };
        await listen(() => host.listenOutput(dispatchOutput));
        await listen(() => host.listenExit(dispatchExit));
      })().catch((error: unknown) => {
        for (const stop of unlisteners.splice(0)) stop();
        listenersReady = null;
        throw error;
      });
    }
    return listenersReady;
  }

  /** base64 → 字节（Rust 侧标准字母表 + padding）。 */
  function decodeBase64(data: string): Uint8Array {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function dispatchOutput(payload: PtyOutputWire): void {
    if (disposed || typeof payload?.handle !== "number") {
      return;
    }
    const route = routes.get(payload.handle);
    if (route === undefined) {
      pushEarly({ kind: "output", payload });
      return;
    }
    route.onData(decodeBase64(payload.data));
  }

  function dispatchExit(payload: PtyExitWire): void {
    if (disposed || typeof payload?.handle !== "number") {
      return;
    }
    const route = routes.get(payload.handle);
    if (route === undefined) {
      pushEarly({ kind: "exit", payload });
      return;
    }
    route.onExit(payload.code ?? null);
  }

  // ---------------------------------------------------------------------------
  // 连接实现
  // ---------------------------------------------------------------------------

  class PtyConnectionImpl implements PtyConnection {
    readonly handle: number;
    readonly shellName: string;
    private dataCallback: ((bytes: Uint8Array) => void) | null = null;
    private exitCallback: ((code: number | null) => void) | null = null;
    /** exit 后本连接停发一切 write/resize（主防线；Rust 侧检查仅 best-effort）。 */
    private exited = false;
    private closed = false;
    /** 已收到的退出码（exit 先于 onExit 注册时，注册瞬间补发）。 */
    private exitCode: number | null = null;
    /** 消费者注册前的输出缓冲（early 回放 / 卸载窗口），注册后按序 flush。 */
    private pendingOutput: Uint8Array[] = [];
    /** 输出缓冲上限（字节）：Rust 单块 ≤64KB，至少容 4 块，防无界增长。 */
    private static readonly PENDING_OUTPUT_LIMIT_BYTES = 256 * 1024;
    private lastCols = 0;
    private lastRows = 0;
    private resizeInFlight = false;
    private pendingResize: { cols: number; rows: number } | null = null;

    constructor(handle: number, shellName = "") {
      this.handle = handle;
      this.shellName = shellName;
    }

    write(data: string): void {
      if (this.closed || this.exited) return;
      host.write(this.handle, data).catch((error: unknown) => {
        logger.warn("pty_write 失败", { handle: this.handle, error });
      });
    }

    resize(cols: number, rows: number): void {
      if (this.closed || this.exited) return;
      if (cols === this.lastCols && rows === this.lastRows) {
        return;
      }
      if (this.resizeInFlight) {
        // 单飞：在飞的 resize 返回后再补发最新值（风暴收敛为一次）
        this.pendingResize = { cols, rows };
        return;
      }
      this.resizeInFlight = true;
      void (async () => {
        try {
          await host.resize(this.handle, cols, rows);
          this.lastCols = cols;
          this.lastRows = rows;
        } catch (error) {
          logger.warn("pty_resize 失败", {
            handle: this.handle,
            cols,
            rows,
            error,
          });
        } finally {
          this.resizeInFlight = false;
          const pending = this.pendingResize;
          this.pendingResize = null;
          if (pending !== null) {
            this.resize(pending.cols, pending.rows);
          }
        }
      })();
    }

    onData(callback: (bytes: Uint8Array) => void): void {
      this.dataCallback = callback;
      // 补发消费前缓冲的输出（early 回放 / 卸载窗口），按到达顺序
      if (this.pendingOutput.length > 0) {
        const pending = this.pendingOutput;
        this.pendingOutput = [];
        for (const bytes of pending) {
          callback(bytes);
        }
      }
    }

    onExit(callback: (code: number | null) => void): void {
      this.exitCallback = callback;
      // exit 已先发生：注册瞬间以缓存码补发（不因注册晚于事件而丢 markExited）
      if (this.exited) {
        callback(this.exitCode);
      }
    }

    dispose(): void {
      this.closed = true;
      routes.delete(this.handle);
      connections.delete(this.handle);
    }

    /** 摘除消费者（视图卸载）：输出转缓冲、退出只缓存码，等待 adopt 补发。 */
    detach(): void {
      this.dataCallback = null;
      this.exitCallback = null;
    }

    /** host 单例监听的输出入口（PtyRoute 形态）。 */
    handleOutput(bytes: Uint8Array): void {
      if (this.exited) {
        return;
      }
      if (this.dataCallback === null) {
        // 消费者未注册：缓冲（超过上限丢最旧——spawn 链路该窗口仅同步相邻；
        // 卸载窗口可能很长，上限防内存无界增长）
        this.pendingOutput.push(bytes);
        const limit = PtyConnectionImpl.PENDING_OUTPUT_LIMIT_BYTES;
        let total = 0;
        let cut = 0;
        for (
          let index = this.pendingOutput.length - 1;
          index >= 0;
          index -= 1
        ) {
          total += this.pendingOutput[index]?.byteLength ?? 0;
          if (total > limit) {
            cut = index + 1;
            break;
          }
        }
        if (cut > 0) {
          this.pendingOutput.splice(0, cut);
        }
        return;
      }
      this.dataCallback(bytes);
    }

    /** host 单例监听的退出入口：置 exited 位 → 摘注册表 → 通知视图。 */
    handleExit(code: number | null): void {
      if (this.exited) {
        return;
      }
      this.exited = true;
      this.exitCode = code;
      this.dispose();
      this.exitCallback?.(code);
    }
  }

  // ---------------------------------------------------------------------------
  // 对外 API
  // ---------------------------------------------------------------------------

  /**
   * 创建 PTY 连接：订阅先于 spawn（tauriStdioTransport.ts:334-344 同纪律），
   * spawn 成功后注册 routes/connections 并回放早到事件。
   */
  async function spawn(options: PtySpawnOptions): Promise<PtyConnection> {
    if (disposed || isExiting())
      throw new Error("Terminal service is stopping");
    if (!host.isNative())
      throw new Error("终端仅在 Tauri 桌面应用内可用（当前环境无 PTY 宿主）");
    await ensureListeners();
    if (disposed || isExiting())
      throw new Error("Terminal service is stopping");
    const spawnWire = await host.spawn(options);
    if (typeof spawnWire?.handle !== "number") {
      throw new Error("pty_spawn 返回缺少 handle（Rust 契约不符）");
    }
    handles.add(spawnWire.handle);
    if (disposed || isExiting()) {
      await close(spawnWire.handle);
      throw new Error("Terminal service is stopping");
    }
    const connection = new PtyConnectionImpl(
      spawnWire.handle,
      typeof spawnWire.shellName === "string" ? spawnWire.shellName : "",
    );
    routes.set(connection.handle, {
      onData: (bytes) => connection.handleOutput(bytes),
      onExit: (code) => connection.handleExit(code),
    });
    connections.set(connection.handle, connection);
    // 回放早到事件（本 handle 的）：**按到达顺序**——多块输出倒序重排会
    // 打乱字节流；exit 在 Rust 侧保证最后到达，原序回放才能先输出后退出。
    const keep: typeof early = [];
    for (const item of early.splice(0)) {
      if (item.payload.handle !== connection.handle) {
        keep.push(item);
        continue;
      }
      if (item.kind === "output") {
        connection.handleOutput(
          decodeBase64((item.payload as PtyOutputWire).data),
        );
      } else {
        connection.handleExit((item.payload as PtyExitWire).code ?? null);
      }
    }
    early.push(...keep);
    return connection;
  }

  function close(handle: number): Promise<void> {
    const existing = closing.get(handle);
    if (existing) return existing;
    if (disposed && !handles.has(handle)) return Promise.resolve();
    connections.get(handle)?.detach();
    connections.get(handle)?.dispose();
    routes.delete(handle);
    const task = (async () => {
      try {
        await host.kill(handle);
      } catch {
        // A handle may already have exited. Release its native entry anyway.
      }
      await host.release(handle);
      handles.delete(handle);
    })().finally(() => closing.delete(handle));
    closing.set(handle, task);
    return task;
  }

  function open(options: PtySpawnOptions): Promise<PtyConnection> {
    const task = spawn(options).finally(() => openings.delete(task));
    openings.add(task);
    return task;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    for (const stop of unlisteners.splice(0)) stop();
    early.length = 0;
    const [, results] = await Promise.all([
      Promise.allSettled([...openings]),
      Promise.allSettled([...handles].map((handle) => close(handle))),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason as unknown;
  }

  async function resolveCwd(project: string | null): Promise<string | null> {
    if (project) return project;
    try {
      return (await host.homeDir()) || null;
    } catch {
      return null;
    }
  }

  return {
    open,
    close,
    dispose,
    resolveCwd,
    earlyCountForTest,
    drainOpenings: async () => {
      await Promise.allSettled([...openings]);
    },
    find: (handle: number) => connections.get(handle) ?? null,
  };
}
