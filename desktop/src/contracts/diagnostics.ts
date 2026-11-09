import type { LogEntry, LogLevel } from "../shared/diagnosticEvents/logger.ts";
import type { SessionSnapshot } from "./projectSessions.ts";

export interface DiagnosticsStatus {
  now: number;
  droppedBatches: number;
  error: string | null;
  observing: boolean;
  latestId: number;
}

export interface DiagnosticRecord {
  id: number;
  at: number;
  runId: string;
  source: string;
  level: string;
  channel: string;
  message: string;
  context: Record<string, unknown>;
  hasRaw?: boolean;
}

export interface DiagnosticsSnapshot {
  at: number;
  data: {
    runtime: {
      sessionId?: string | null;
      workspacePath?: string;
      isActive?: boolean;
      listOnly?: boolean;
      agentCrashed?: string | null;
      busyReason?: string | null;
      [key: string]: unknown;
    }[];
    memory: { at: number; bytes: number }[];
    memorySamplingSupported: boolean;
    storage?: { bytes: number; projects: number };
    theme: string;
  };
}

export interface DiagnosticsReader {
  isNative(): boolean;
  status(): Promise<DiagnosticsStatus>;
  snapshot(): Promise<DiagnosticsSnapshot | null>;
  query(
    filters: Readonly<Record<string, unknown>>,
  ): Promise<DiagnosticRecord[]>;
  raw(id: number): Promise<string>;
  export(
    filters: Readonly<Record<string, unknown>>,
  ): Promise<number | null>;
}

export type DiagnosticsTab = "logs" | "perf" | "runtime";

export interface DiagnosticsLogs {
  readonly entries: readonly LogEntry[];
  readonly level: LogLevel;
  setLevel(this: void, level: LogLevel): void;
  clear(this: void): void;
}

export interface MemorySample {
  readonly at: number;
  readonly bytes: number;
}

export interface DiagnosticsService {
  readonly reader: DiagnosticsReader;
  readonly logs: SessionSnapshot<DiagnosticsLogs>;
  readonly memory: {
    readonly supported: boolean;
    readonly samples: SessionSnapshot<readonly MemorySample[]>;
  };
  readonly view: SessionSnapshot<DiagnosticsTab>;
  selectTab(tab: DiagnosticsTab): void;
  open(): void;
  startupTheme(): "dark" | "warm";
}
