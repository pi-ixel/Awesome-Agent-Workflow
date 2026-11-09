/**
 * 进程内 ACP transport：两条对连的消息管道，行为对齐 stdio 语义
 * （写行 → 对端按行收到；close → 对端收到 EOF；kill → 对端收到退出）。
 *
 * 用途：单测把 connection/session 接到 mock/echo-agent，全程不碰子进程。
 */

import {
  HandlerSlot,
  type AcpTransport,
  type TransportExit,
  type TransportLineHandler,
  type TransportStderrHandler,
  type TransportExitHandler,
} from "./acpTransport.ts";
import { LineDecoder } from "../framing.ts";
import { AcpWriteError } from "../errors.ts";

/** 对端视角的端点：收行、收 stderr、收退出。 */
export interface InMemoryPeer {
  onLine(handler: TransportLineHandler): void;
  onStderr(handler: TransportStderrHandler): void;
  /** 模拟对端进程退出。 */
  exit(code: number | null, signal?: string | null): void;
  /** 向本端写一行（即模拟对端的 stdout）。 */
  writeLine(line: string): void;
  /** 向本端写一段 stderr。 */
  writeStderr(chunk: string): void;
}

/**
 * 创建一对对连的 transport：`client` 供协议层使用；`peer` 是对端
 * （仿真 agent）的操纵面。两端行为对称，只是命名按用途区分。
 */
export function createTransportPair(): {
  client: AcpTransport;
  peer: InMemoryPeer;
} {
  const side = new InMemoryTransportSide();
  const other = new InMemoryTransportSide();
  side.connect(other);
  other.connect(side);
  return { client: side, peer: makePeerApi(other) };
}

function makePeerApi(side: InMemoryTransportSide): InMemoryPeer {
  return {
    onLine: (handler) => side.onLine(handler),
    onStderr: (handler) => side.onStderr(handler),
    exit: (code, signal = null) => void side.reportExit({ code, signal }),
    writeLine: (line) => side.pushOutLine(line),
    writeStderr: (chunk) => side.pushOutStderr(chunk),
  };
}

/** 单侧：writeLine 从管道流向对端；onLine 收到对端写来的行。 */
class InMemoryTransportSide implements AcpTransport {
  private peer: InMemoryTransportSide | null = null;
  private readonly lineSlot = new HandlerSlot<TransportLineHandler>();
  private readonly stderrSlot = new HandlerSlot<TransportStderrHandler>();
  private readonly exitSlot = new HandlerSlot<TransportExitHandler>();
  /** 模拟本端进程的 stdout 分帧（对端写来的字节流按行还原）。 */
  private readonly inDecoder = new LineDecoder();
  private closed = false;
  private exitReported: TransportExit | null = null;

  connect(peer: InMemoryTransportSide): void {
    this.peer = peer;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  writeLine(line: string): void {
    if (this.closed) {
      throw new AcpWriteError("内存管道已关闭，无法写入");
    }
    const peer = this.peer;
    if (peer === null || peer.closed) {
      throw new AcpWriteError("内存管道对端已关闭，无法写入");
    }
    peer.receiveLine(`${line}\n`);
  }

  onLine(handler: TransportLineHandler): void {
    this.lineSlot.set(handler);
  }

  onStderr(handler: TransportStderrHandler): void {
    this.stderrSlot.set(handler);
  }

  onExit(handler: TransportExitHandler): void {
    this.exitSlot.set(handler);
    // 退出先于订阅发生时补发
    if (this.exitReported !== null) {
      handler(this.exitReported);
    }
  }

  async close(): Promise<TransportExit> {
    return this.shutdown({ code: 0, signal: null });
  }

  async kill(): Promise<TransportExit> {
    // 模拟强杀：对端视角即被 SIGKILL
    return this.shutdown({ code: null, signal: "SIGKILL" });
  }

  // ----------------------------------------------------------------- 对端操纵面

  /** 对端写入本端的 stdout 字节流。 */
  receiveLine(raw: string): void {
    const bytes = new TextEncoder().encode(raw);
    const lines = this.inDecoder.push(bytes);
    for (const line of lines) {
      this.lineSlot.emit(line);
    }
  }

  /** 对端主动退出（进程视角的 exit）：本端收到，对端管道随即失效。 */
  reportExit(exit: TransportExit): void {
    if (this.exitReported !== null) {
      return;
    }
    this.exitReported = exit;
    this.closed = true;
    this.exitSlot.emit(exit);
    // 对端视角：与之相连的进程退出了——同样触发一次 exit 并封写
    const peer = this.peer;
    if (peer !== null) {
      peer.receivePeerExit(exit);
    }
  }

  private receivePeerExit(exit: TransportExit): void {
    if (this.exitReported !== null) {
      return;
    }
    this.exitReported = exit;
    this.closed = true;
    this.exitSlot.emit(exit);
  }

  /** 仿真 agent 的输出通路（peer.writeLine 转发）。 */
  pushOutLine(line: string): void {
    const peer = this.peer;
    if (peer === null || peer.closed) {
      return;
    }
    peer.receiveLine(`${line}\n`);
  }

  pushOutStderr(chunk: string): void {
    const peer = this.peer;
    if (peer === null) {
      return;
    }
    peer.stderrSlot.emit(chunk);
  }

  private shutdown(exit: TransportExit): Promise<TransportExit> {
    if (this.exitReported !== null) {
      return Promise.resolve(this.exitReported);
    }
    this.reportExit(exit);
    return Promise.resolve(exit);
  }
}
