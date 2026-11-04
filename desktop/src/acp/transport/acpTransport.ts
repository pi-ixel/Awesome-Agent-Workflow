/**
 * ACP transport 接口。
 *
 * 只约定「行进出行、stderr 旁路、退出通知、关闭与强杀」四件事，
 * 不绑定任何运行时：Node 子进程（nodeStdioTransport）、进程内仿真
 * （inMemoryTransport）、未来 webview 侧的 Tauri IPC 转发实现都满足
 * 同一接口——协议层（connection / session）因此对运行时无感。
 */

/** transport 终止原因：进程自然退出、被信号杀死、或主动 kill 完成。 */
export interface TransportExit {
  /** 进程退出码；被信号杀死时为 null。 */
  readonly code: number | null;
  /** 终止信号名（如 "SIGTERM"）；正常退出为 null。 */
  readonly signal: string | null;
}

/** stdout 上一条完整行的回调。 */
export type TransportLineHandler = (line: string) => void;
/** stderr 原始文本块回调（已按 UTF-8 解码）。 */
export type TransportStderrHandler = (chunk: string) => void;
/** 进程/通道退出回调（至多触发一次，且总在最后）。 */
export type TransportExitHandler = (exit: TransportExit) => void;

export interface AcpTransport {
  /** 写出一行（实现自行补 `\n`）。通道已关闭时抛 AcpWriteError。 */
  writeLine(line: string): void;

  /** 订阅 stdout 完整行（分帧由实现内部处理）。 */
  onLine(handler: TransportLineHandler): void;
  /** 订阅 stderr 文本块。 */
  onStderr(handler: TransportStderrHandler): void;
  /** 订阅退出事件。 */
  onExit(handler: TransportExitHandler): void;
  /** Confirmed channel failure; does not imply the owned process has exited. */
  onFailure?(handler: (reason: string) => void): void;

  /**
   * 优雅关闭：关 stdin、等待对端自行退出；超过 graceMs 后升级为
   * kill()（进程树终止）。重复调用幂等。
   */
  close(graceMs?: number): Promise<TransportExit>;

  /**
   * 强制终止：Windows 上 `taskkill /PID <pid> /T /F`（单杀父进程会留下
   * 孤儿子进程，见 Python 参考实现 `_terminate_process_tree`），POSIX 上
   * terminate → 等待 → kill。重复调用幂等。
   */
  kill(): Promise<TransportExit>;

  /** 是否已关闭（close/kill 完成或对端退出后为 true）。 */
  readonly isClosed: boolean;
  dispose?(): void;
}

/**
 * 通用订阅登记（多播）：各回调可同时有多个订阅方——transport 内部
 * （连接层的断线唤醒）与外部观察者（崩溃侦测、测试断言）并存，谁也不能
 * 顶掉谁；退订只移除自己。
 */
export class HandlerSlot<T extends (...args: never[]) => void> {
  private readonly handlers = new Set<T>();

  set(handler: T): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: Parameters<T>): void {
    for (const handler of [...this.handlers]) {
      handler(...args);
    }
  }

  get isSet(): boolean {
    return this.handlers.size > 0;
  }
}
