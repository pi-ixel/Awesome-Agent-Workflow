/** PTY I/O port used by the terminal view. */
export interface PtyConnection {
  readonly handle: number;
  readonly shellName: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Replays output buffered before the consumer attaches. */
  onData(callback: (bytes: Uint8Array) => void): void;
  /** Replays a previously received exit code. */
  onExit(callback: (code: number | null) => void): void;
  /** Removes the registration while leaving the PTY alive. */
  dispose(): void;
  /** Detaches the view and resumes buffering while keeping the registration. */
  detach(): void;
}

export interface TerminalTab {
  readonly id: string;
  readonly kind: "shell";
  readonly project: string | null;
  readonly index: number;
  readonly shellLabel: string | null;
  readonly shellName: string | null;
  readonly handle: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
}

export interface TerminalTabsSnapshot {
  readonly tabs: readonly TerminalTab[];
  readonly activeTabId: string | null;
  readonly connectionErrors: Readonly<Record<string, string>>;
}
