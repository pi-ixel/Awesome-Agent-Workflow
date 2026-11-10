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

export type AcpRawDirection = "in" | "out";

/** Exact ACP protocol line and its owning connection, before parsing or redaction. */
export type AcpRawWriter = (
  line: string,
  connectionId: string,
  direction: AcpRawDirection,
) => void;

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
    memory: MemorySample[];
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

export interface MemorySample {
  readonly at: number;
  readonly bytes: number;
}
