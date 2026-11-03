/**
 * PTY 宿主桥：xterm 前端 ↔ Rust pty 命令/事件的一条通道（desktop/src/terminal）。
 *
 * 设计（对齐 acp/transport/tauriStdioTransport 的纪律）：
 * - **单例监听**：`pty://output` / `pty://exit` 各 listen 一次（模块生命周期 =
 *   webview 生命周期，永不退订），事件到达后按 handle 经模块级 `routes`
 *   分发给对应连接——N 个页签零监听放大，Rust 侧广播语义不变；
 * - **连接注册表**：`connections` 持有全部存活连接。TerminalSessionView 的
 *   宿主可能因错误边界（AppErrorBoundary 包全树）重挂，连接不在组件里而在
 *   注册表——重挂后按 tab.handle **adopt** 既有连接，恢复输入输出，避免
 *   「store 标 running 而连接悬空」；
 * - **早到缓冲**：spawn 完成前（订阅已就位、handle 未注册）到达的事件进
 *   early 缓冲，连接创建成功后按 handle 回放；缓冲按条数 / base64 字节数
 *   封顶丢最旧——永不认领的句柄事件（关闭后的尾部输出等）不无限滞留；
 * - **关闭语义（修 E）**：`closeConnection` = 摘注册表（事件静默）+
 *   fire-and-forget 顺序链 `pty_kill` → `pty_release`（release 严格在 kill
 *   之后）；dispose 路径（错误边界重挂）只摘注册表、不 kill——PTY 存活等
 *   待 adopt。
 *
 * Rust 命令/事件契约（已对齐 src-tauri/src/terminal_pty.rs 的实际签名；
 * 结构体入参按 Tauri 惯例嵌在 Rust 形参名下——同仓先例 panelService.ts:68
 * `call("panel_git_diff", { project, change })` ↔ `panel_git_diff(project,
 * change: Change)`）：
 * - `pty_spawn({ request: { file?, cwd?, cols?, rows?, env? } })` →
 *   `{ handle, pid, shell, shellName }`（file/env 缺省走 Rust 平台默认
 *   shell 解析；cols/rows 0 → Rust 兜底 80×24；cwd null → Rust 兜底
 *   USERPROFILE/HOME，再缺省继承宿主 cwd）；
 * - `pty_write({ handle, data })`（data 为 UTF-8 字符串）；
 * - `pty_resize({ handle, cols, rows })`；
 * - `pty_kill({ handle })` → `{ code, signal }` / `pty_release({ handle })`；
 * - 事件 `pty://output` → `{ handle, data }`（data 为 base64 字节）、
 *   `pty://exit` → `{ handle, code, signal }`（code/signal 可为 null；
 *   至多一次、总在最后。signal 为终止信号名/合成标记，前端暂不消费，
 *   只取 code——形状收全记录在 PtyExitWire）。
 */
import { invoke } from "../core/invoke.ts";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";

import { isTauriEnv } from "../core/host.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("pty");

/** pty://output 事件载荷（Rust 契约）。 */
interface PtyOutputWire {
  readonly handle: number;
  /** base64 编码的输出字节。 */
  readonly data: string;
}

/** pty://exit 事件载荷（Rust 契约；signal 暂不消费，形状收全备查）。 */
interface PtyExitWire {
  readonly handle: number;
  readonly code: number | null;
  readonly signal: string | null;
}

/** pty_spawn 返回（Rust 契约；shellName 供 PSReadLine 归一化与工具栏展示）。 */
interface PtySpawnWire {
  readonly handle: number;
  readonly pid: number | null;
  readonly shell: string;
  readonly shellName: string;
}

/** 单连接的路由回调（host 单例监听 → 按 handle 分发的目标形态）。 */
interface PtyRoute {
  onData(bytes: Uint8Array): void;
  onExit(code: number | null): void;
}

/** 一条 PTY 连接（xterm 视图只面向此接口，不见 invoke/listen 细节）。 */
export interface PtyConnection {
  readonly handle: number;
  /**
   * shell 显示名（pty_spawn 的 shellName，如 "pwsh"/"powershell"）——
   * PSReadLine 输出归一化与工具栏展示用；未知为空串。
   */
  readonly shellName: string;
  /** 终端键入回传（term.onData → conn.write）。 */
  write(data: string): void;
  /** 尺寸同步（fit 后调用；conn 内去重 + 单飞）。 */
  resize(cols: number, rows: number): void;
  /**
   * 注册输出回调（覆盖式，每连接至多一个消费者）。注册瞬间补发消费前
   * 缓冲的输出（early 回放 / 消费者摘除窗口）——spawn 链路里 Rust 读线程
   * 早于 invoke 返回就开始发事件，这批事件必须能送达后注册的消费者。
   */
  onData(callback: (bytes: Uint8Array) => void): void;
  /**
   * 注册退出回调（覆盖式）。若退出已先发生（exit 早于注册），注册瞬间
   * 以缓存的退出码补发——exit 不能因注册晚于事件而丢 markExited。
   */
  onExit(callback: (code: number | null) => void): void;
  /**
   * 仅摘除注册表（错误边界重挂的 dispose 语义）：不 kill、不 release——
   * PTY 存活，重挂后按 handle adopt。进程关闭走 `closeConnection`。
   */
  dispose(): void;
  /**
   * 摘除当前消费者（视图卸载用）：此后输出转入缓冲（上限内）、退出只
   * 缓存退出码，等重挂 adopt 时经 onData/onExit 注册瞬间补发。区别于
   * dispose：连接留在注册表，PTY 存活。
   */
  detach(): void;
}

// ---------------------------------------------------------------------------
// 模块级单例状态
// ---------------------------------------------------------------------------

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
export function earlyCountForTest(): number {
  return early.length;
}

let unlisteners: Array<() => void> = [];
let listenersReady: Promise<void> | null = null;

/** 首调挂载单例监听；此后永不再挂、永不退订（模块生命周期 = webview 生命周期）。 */
function ensureListeners(): Promise<void> {
  if (listenersReady === null) {
    listenersReady = (async () => {
      unlisteners.push(
        await listen<PtyOutputWire>("pty://output", (event) => {
          dispatchOutput(event.payload);
        }),
      );
      unlisteners.push(
        await listen<PtyExitWire>("pty://exit", (event) => {
          dispatchExit(event.payload);
        }),
      );
    })().catch((error: unknown) => {
      // 挂载失败允许重试：清空已挂的半个监听，下次 createPty 再来
      for (const unlisten of unlisteners) unlisten();
      unlisteners = [];
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
  if (typeof payload?.handle !== "number") {
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
  if (typeof payload?.handle !== "number") {
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
    if (this.exited) {
      return;
    }
    invoke("pty_write", { handle: this.handle, data }).catch(
      (error: unknown) => {
        logger.warn("pty_write 失败", { handle: this.handle, error });
      },
    );
  }

  resize(cols: number, rows: number): void {
    if (this.exited) {
      return;
    }
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
        await invoke("pty_resize", { handle: this.handle, cols, rows });
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
      for (let index = this.pendingOutput.length - 1; index >= 0; index -= 1) {
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
export async function createPtyTerminalConnection(options: {
  readonly cwd: string | null;
  readonly cols: number;
  readonly rows: number;
}): Promise<PtyConnection> {
  if (!isTauriEnv()) {
    // 修 L：非 Tauri 环境（浏览器 / vitest）给可读错误，而非 IPC 层的含混异常
    throw new Error("终端仅在 Tauri 桌面应用内可用（当前环境无 PTY 宿主）");
  }
  await ensureListeners();
  // Rust 命令是 `pty_spawn(app, request: PtySpawnRequest, webview)`：入参
  // 必须嵌在形参名 `request` 下（平铺 { cwd, cols, rows } 会因缺 key 被
  // Tauri 拒绝；同仓先例 panelService.ts:68 的 { project, change }）。
  const spawnWire = await invoke<PtySpawnWire>("pty_spawn", {
    request: {
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
    },
  });
  if (typeof spawnWire?.handle !== "number") {
    throw new Error("pty_spawn 返回缺少 handle（Rust 契约不符）");
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

/**
 * 关闭连接（页签关闭流程）：摘注册表（事件静默）+ 顺序链 kill → release
 * （release 严格在 kill 后，修 E）。fire-and-forget：UI 不等进程收尸。
 */
export function closeConnection(handle: number): void {
  connections.get(handle)?.dispose();
  routes.delete(handle);
  void (async () => {
    try {
      await invoke("pty_kill", { handle });
    } catch {
      // 已退出 / 不存在的 handle：kill 失败不阻断 release
    }
    try {
      await invoke("pty_release", { handle });
    } catch (error) {
      logger.warn("pty_release 失败（Rust 侧随进程退出兜底回收）", {
        handle,
        error,
      });
    }
  })();
}

/** 查既有连接（TerminalSessionView 重挂 adopt 用）；无则 null。 */
export function getConnection(handle: number): PtyConnection | null {
  return connections.get(handle) ?? null;
}

/**
 * spawn 工作目录双层兜底（修 M）：优先项目路径；否则前端取用户主目录；
 * 都无则 null——Rust 侧再兜底 USERPROFILE/HOME，仍无则不设 cwd 继承宿主
 * 进程工作目录（显式记录的最终回落）。
 */
export async function resolveDefaultCwd(
  contextPath: string | null,
): Promise<string | null> {
  if (contextPath !== null && contextPath !== "") {
    return contextPath;
  }
  try {
    const home = await homeDir();
    return home === "" ? null : home;
  } catch {
    return null;
  }
}
