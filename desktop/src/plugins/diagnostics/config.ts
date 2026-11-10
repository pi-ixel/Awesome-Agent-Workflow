import { LogSink } from "./capture/logSink.ts";

/** Create before installing Host so early IPC records are available to capture. */
export function createDiagnosticsLogSink() {
  return new LogSink(undefined, "debug");
}

export interface DiagnosticsCapture {
  readonly snapshot: () => object;
  /** Shared by successive installs of the main-window capture. */
  readonly cursor: { sequence: number };
}

export interface DiagnosticsOptions {
  readonly logSink?: LogSink;
  readonly capture?: DiagnosticsCapture;
}
