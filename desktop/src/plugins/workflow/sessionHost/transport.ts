/**
 * ADR 024 §5 ②：节点 Agent / 问题池 tracker 的进程工厂（transport.ts）。
 *
 * 原实现（源文件 nativeSessionHost.ts 底部的 createSpawnTransport，行为
 * 基准）与 realRuntime 的 createAgentTransport 走同一条 `acp_spawn` Tauri
 * IPC 路径（旧 src/acp/transport/tauriStdioTransport.ts）；远端底座把这条
 * 路径收敛为 `AcpProcessHost` 端口（spawn/subscribe/writeLine/closeInput/
 * killTree/release，wire 契约 `invoke("acp_spawn")` + `listen("acp://…")`
 * 与本地 transport 完全一致——ADR 024 §6 修正 1：近乎零成本换接）。本模块
 * 按 host.acpProcess 实现同一 `AcpTransport` 面。
 *
 * 订阅必须在 spawn **之前**：`acp://stdout` 等事件没有重放机制，「启动即
 * 打印服务地址」的 agent 在 spawn 返回前就可能说话——这里先订阅并把事件
 * 暂存，拿到句柄后按句柄回放（与远端 acpConnection 的
 * createTauriStdioTransport 同一编排）。事件载荷按 handle 过滤，错投帧
 * 丢弃（ADR 024 §11 风险①的对策：保留 handle 断言）。
 */
import { AcpWriteError } from "../../host/service.ts";
import { HandlerSlot } from "../../../shared/handlerSlot.ts";
import type {
  AcpProcessEvent,
  AcpProcessHost,
  AcpTransport,
  AcpTransportLaunchOptions,
  TransportExit,
  TransportExitHandler,
  TransportLineHandler,
  TransportStderrHandler,
} from "../../host/types.ts";

/** stdout / stderr 事件载荷（acp_process.rs AcpIoEvent）。 */
interface AcpIoEventWire {
  readonly handle?: unknown;
  readonly data?: unknown;
}

/** 退出事件载荷（acp_process.rs AcpExitEvent）。 */
interface AcpExitEventWire {
  readonly handle?: unknown;
  readonly code?: unknown;
  readonly signal?: unknown;
}

/** 优雅关闭（关 stdin 后）等待对端自退的默认宽限（对齐 Node 实现）。 */
const DEFAULT_CLOSE_GRACE_MS = 5_000;

/** Rust 事件名与句柄的绑定（三个事件共用 handle 过滤）。 */
const processEvents = ["stdout", "stderr", "exit"] as const;

function isHandle(payload: unknown, handle: number): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  return (payload as { readonly handle?: unknown }).handle === handle;
}

/**
 * host.acpProcess 承载的 IPC transport。构造是异步的（spawn + 事件订阅），
 * 请用 `createHostAcpProcessTransport` 工厂；构造成功即代表进程已在运行。
 */
class HostAcpProcessTransport implements AcpTransport {
  private readonly handle: number;
  private readonly host: AcpProcessHost;
  private unlisteners: (() => void)[] = [];
  private disposal?: Promise<void>;
  private readonly lineSlot = new HandlerSlot<TransportLineHandler>();
  private readonly stderrSlot = new HandlerSlot<TransportStderrHandler>();
  private readonly exitSlot = new HandlerSlot<TransportExitHandler>();
  private readonly failureSlot = new HandlerSlot<(reason: string) => void>();

  private closed = false;
  private writeBroken = false;
  private exitPromise: Promise<TransportExit> | null = null;
  private killPromise: Promise<TransportExit> | null = null;
  private reportedExit: TransportExit | null = null;
  private exitWaiterResolve: ((exit: TransportExit) => void) | null = null;
  private readonly exitWaiter: Promise<TransportExit>;
  /**
   * 订阅前到达的行/块：进程一启动就可能说话（公告、甚至早到的 JSON-RPC），
   * 而 onLine 由上层在拿到 transport 之后才挂。暂存到首次订阅时补发，
   * 否则这段输出会凭空丢失。
   */
  private readonly earlyLines: string[] = [];
  private readonly earlyStderr: string[] = [];

  /** 请用 createHostAcpProcessTransport 工厂创建（spawn + 事件订阅一体）。 */
  constructor(handle: number, host: AcpProcessHost) {
    this.handle = handle;
    this.host = host;
    this.exitWaiter = new Promise<TransportExit>((resolve) => {
      this.exitWaiterResolve = resolve;
    });
  }

  /** 工厂在事件订阅成功后回填退订函数（订阅晚于构造完成）。 */
  bindUnlisteners(unlisteners: readonly (() => void)[]): void {
    this.unlisteners = [...unlisteners];
  }

  /** agent 进程句柄（日志与诊断用）。 */
  get processHandle(): number {
    return this.handle;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  writeLine(line: string): void {
    if (this.closed) {
      throw new AcpWriteError("ACP 进程已退出，无法写入");
    }
    if (this.writeBroken) {
      throw new AcpWriteError("ACP stdin 已断裂（上次写入失败），无法写入");
    }
    // IPC 写入异步完成：失败经 stderr 旁路报告，下次调用同步抛错
    void this.host.writeLine(this.handle, line).catch((error: unknown) => {
      if (this.closed) {
        return; // 进程已退出，exit 事件才是权威信号
      }
      this.writeBroken = true;
      const reason = error instanceof Error ? error.message : String(error);
      this.failureSlot.emit(reason);
      this.stderrSlot.emit(`stdin 写入失败：${reason}`);
    });
  }

  onLine(handler: TransportLineHandler): void {
    this.lineSlot.set(handler);
    for (const line of this.earlyLines.splice(0)) {
      handler(line);
    }
  }

  onStderr(handler: TransportStderrHandler): void {
    this.stderrSlot.set(handler);
    for (const chunk of this.earlyStderr.splice(0)) {
      handler(chunk);
    }
  }

  onExit(handler: TransportExitHandler): void {
    this.exitSlot.set(handler);
    // 退出先于订阅发生时补发（对端可能在订阅前崩溃）
    if (this.reportedExit !== null) {
      handler(this.reportedExit);
    }
  }

  onFailure(handler: (reason: string) => void): void {
    this.failureSlot.set(handler);
  }

  async close(graceMs: number = DEFAULT_CLOSE_GRACE_MS): Promise<TransportExit> {
    if (this.exitPromise !== null) {
      return this.exitPromise;
    }
    this.exitPromise = this.gracefulExit(graceMs);
    const exit = await this.exitPromise;
    this.closed = true;
    return exit;
  }

  async kill(): Promise<TransportExit> {
    if (this.exitPromise !== null) {
      return this.exitPromise;
    }
    this.killPromise ??= this.killTree();
    const exit = await this.killPromise;
    this.closed = true;
    return exit;
  }

  // ----------------------------------------------------------------- 内部

  /** 关 stdin → 等对端自退 → 超时升级强杀（对齐 Node 的 gracefulExit）。 */
  private async gracefulExit(graceMs: number): Promise<TransportExit> {
    try {
      await this.host.closeInput(this.handle);
    } catch {
      // 进程可能已退出：继续等 exit 事件，超时走强杀
    }
    const winner = await Promise.race([
      this.exitWaiter,
      delay(graceMs).then(() => "timeout" as const),
    ]);
    if (winner === "timeout") {
      return this.killTree();
    }
    return winner;
  }

  /** 调宿主杀树命令并收口。 */
  private async killTree(): Promise<TransportExit> {
    try {
      return await this.host.killTree(this.handle);
    } catch {
      // 句柄已不存在等极端情况：以已收到的退出事件为准
      const exit = await Promise.race([
        this.exitWaiter,
        delay(1_000).then(() => null),
      ]);
      return exit ?? { code: null, signal: "SIGKILL" };
    }
  }

  /** 事件回调（工厂里绑定）：分发到本句柄的三个 slot（handle 过滤在先）。 */
  handleStdoutEvent(payload: unknown): void {
    if (this.closed || !isHandle(payload, this.handle)) {
      return;
    }
    const data = (payload as AcpIoEventWire).data;
    if (typeof data === "string") {
      if (!this.lineSlot.isSet) {
        this.earlyLines.push(data);
        return;
      }
      this.lineSlot.emit(data);
    }
  }

  handleStderrEvent(payload: unknown): void {
    if (!isHandle(payload, this.handle)) {
      return;
    }
    const data = (payload as AcpIoEventWire).data;
    if (typeof data === "string") {
      if (!this.stderrSlot.isSet) {
        this.earlyStderr.push(data);
        return;
      }
      this.stderrSlot.emit(data);
    }
  }

  handleExitEvent(payload: unknown): void {
    if (!isHandle(payload, this.handle)) {
      return;
    }
    const wire = payload as AcpExitEventWire;
    const exit: TransportExit = {
      code: typeof wire.code === "number" ? wire.code : null,
      signal: typeof wire.signal === "string" ? wire.signal : null,
    };
    if (this.reportedExit !== null) {
      return; // 幂等：退出至多报告一次
    }
    this.reportedExit = exit;
    this.closed = true;
    this.exitWaiterResolve?.(exit);
    this.exitSlot.emit(exit);
  }

  /**
   * 释放事件订阅并通知宿主删除进程表项（close/kill 完成后可调用；
   * 构造失败时由工厂调用）。释放是幂等的，失败仅意味着表项已不存在。
   */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      try {
        for (const unlisten of this.unlisteners.splice(0)) unlisten();
      } finally {
        await this.host.release(this.handle).catch(() => {});
      }
    })());
  }
}

/**
 * 创建经 host.acpProcess 承载的 transport：订阅三个事件 → spawn 进程 →
 * 回放订阅前的早期事件。失败路径会先退订，不留悬挂监听。
 */
export async function createHostAcpProcessTransport(
  host: AcpProcessHost,
  launch: AcpTransportLaunchOptions,
): Promise<AcpTransport> {
  const [program, ...args] = launch.command;
  if (typeof program !== "string" || program.length === 0) {
    throw new Error("ACP_COMMAND_REQUIRED");
  }
  let transport: HostAcpProcessTransport | null = null;
  const early: { readonly channel: AcpProcessEvent; readonly payload: unknown }[] = [];
  const feed = (channel: AcpProcessEvent, payload: unknown): void => {
    if (transport === null) {
      early.push({ channel, payload });
      return;
    }
    route(transport, channel, payload);
  };
  const subscriptions = await Promise.allSettled(
    processEvents.map(async (channel) =>
      host.subscribe(channel, (payload) => feed(channel, payload)),
    ),
  );
  const unlisteners = subscriptions.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  let handle: number;
  try {
    const failed = subscriptions.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    handle = await host.spawn({
      program,
      args,
      cwd: launch.cwd ?? null,
      extraEnv: launch.extraEnv ?? null,
      isolated: launch.isolated ?? false,
    });
  } catch (error) {
    for (const unlisten of unlisteners) unlisten();
    throw error;
  }
  transport = new HostAcpProcessTransport(handle, host);
  transport.bindUnlisteners(unlisteners);
  // 回放：route 内部按句柄过滤，其他进程的事件自动丢弃
  for (const event of early) {
    route(transport, event.channel, event.payload);
  }
  return transport;
}

/** 把一条事件交给 transport 的对应入口（句柄过滤在 transport 内）。 */
function route(
  transport: HostAcpProcessTransport,
  channel: AcpProcessEvent,
  payload: unknown,
): void {
  if (channel === "stdout") {
    transport.handleStdoutEvent(payload);
  } else if (channel === "stderr") {
    transport.handleStderrEvent(payload);
  } else {
    transport.handleExitEvent(payload);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
