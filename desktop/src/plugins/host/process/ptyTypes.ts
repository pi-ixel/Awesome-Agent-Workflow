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
