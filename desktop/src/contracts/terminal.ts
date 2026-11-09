import type { StoreApi } from "zustand";

/** pty://output 事件载荷（Rust 契约）。 */
export interface PtyOutputWire {
  readonly handle: number;
  /** base64 编码的输出字节。 */
  readonly data: string;
}

/** pty://exit 事件载荷（Rust 契约；signal 暂不消费，形状收全备查）。 */
export interface PtyExitWire {
  readonly handle: number;
  readonly code: number | null;
  readonly signal: string | null;
}

/** pty_spawn 返回（Rust 契约；shellName 供 PSReadLine 归一化与工具栏展示）。 */
export interface PtySpawnWire {
  readonly handle: number;
  readonly pid: number | null;
  readonly shell: string;
  readonly shellName: string;
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

export type TerminalTabKind = "shell";
export type TerminalTabStatus = "running" | "exited";

export interface TerminalTab {
  /** 当前 Terminal 实例内稳定的页签 ID。 */
  readonly id: string;
  readonly kind: TerminalTabKind;
  readonly project: string | null;
  /** shell 页签序号（从 1 起，「编号最小空位」复用）；replay 为 0。 */
  readonly index: number;
  /**
   * shell 页签展示名（创建时由项目名定格，之后不随 contextPath 变化——
   * shell 的工作目录在 spawn 时已固定）；replay 为 null。
   */
  readonly shellLabel: string | null;
  /**
   * shell 显示名（spawn 返回的 shellName 经 formatShellDisplayName 归一化，
   * 如 "PowerShell"/"pwsh"；未 spawn 为 null）；replay 为 null。
   */
  readonly shellName: string | null;
  /** PTY 句柄（spawn 成功写入；replay 为 null；exited 保留至页签关闭）。 */
  readonly handle: number | null;
  readonly status: TerminalTabStatus;
  readonly exitCode: number | null;
}

export interface TerminalTabState {
  /** 页签组（初始为空；打开面板 / Plus 创建 shell 页签）。 */
  readonly tabs: TerminalTab[];
  /** 激活页签 id；空组（未开过 shell）为 null。 */
  readonly activeTabId: string | null;
  /** tabId → spawn / 连接错误（存 store 而非组件态：错误边界重挂后不丢）。 */
  readonly connectionErrors: Readonly<Record<string, string>>;

  /** 打开新 shell 页签（展示名由项目定格）并激活它。 */
  readonly openShellTab: (project: string | null) => void;
  /**
   * 关闭 shell 页签；返回被关页签（调用方据 handle 收尾 PTY），无则 null。
   * 被关页签正激活时激活相邻页签（先左后右）。
   */
  readonly closeShellTab: (tabId: string) => TerminalTab | null;
  /** 激活页签。 */
  readonly setActiveTab: (tabId: string) => void;
  /** spawn 成功写入 handle（null 用于防御路径清空悬空句柄）。 */
  readonly attachHandle: (tabId: string, handle: number | null) => void;
  /** spawn 成功写回 shell 显示名（工具栏展示；页签标题不变）。 */
  readonly attachShellName: (tabId: string, shellName: string) => void;
  /** 进程退出：置 exited 态 + 退出码（handle 保留至页签关闭收尾）。 */
  readonly markExited: (tabId: string, exitCode: number | null) => void;
  /** 记录 / 清除（message 为 null）页签的连接错误。 */
  readonly setConnectionError: (tabId: string, message: string | null) => void;
}

export interface PtySpawnOptions {
  readonly cwd: string | null;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyNativeHost {
  isNative(): boolean;
  homeDir(): Promise<string>;
  listenOutput(receive: (payload: PtyOutputWire) => void): Promise<() => void>;
  listenExit(receive: (payload: PtyExitWire) => void): Promise<() => void>;
  spawn(request: PtySpawnOptions): Promise<PtySpawnWire>;
  write(handle: number, data: string): Promise<void>;
  resize(handle: number, cols: number, rows: number): Promise<void>;
  kill(handle: number): Promise<unknown>;
  release(handle: number): Promise<void>;
}

export interface TerminalService {
  readonly tabs: Pick<
    StoreApi<TerminalTabState>,
    "getState" | "getInitialState" | "subscribe"
  >;
  isActive(): boolean;
  open(options: PtySpawnOptions): Promise<PtyConnection>;
  find(handle: number): PtyConnection | null;
  resolveCwd(project: string | null): Promise<string | null>;
  close(handle: number): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  closeTabs(project?: string): Promise<void>;
}
