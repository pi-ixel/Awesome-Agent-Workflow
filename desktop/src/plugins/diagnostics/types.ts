import type { AcpConnectionDiagnostic } from "../acpConnection/types.ts";

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
    connections?: readonly AcpConnectionDiagnostic[];
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

import type { StorageRequest, StorageResponse } from "./capture/storageRegistry.ts";

export interface DiagnosticsReader {
  storage?: (request: StorageRequest) => Promise<StorageResponse>;
  isNative(): boolean;
  status(): Promise<DiagnosticsStatus>;
  snapshot(): Promise<DiagnosticsSnapshot | null>;
  probeConnection(id: string): Promise<void>;
  resources(): Promise<ResourceSnapshot>;
  query(
    filters: Readonly<Record<string, unknown>>,
  ): Promise<DiagnosticRecord[]>;
  raw(id: number): Promise<string>;
  export(
    filters: Readonly<Record<string, unknown>>,
  ): Promise<number | null>;
}

export interface ResourceGroup {
  readonly id: string;
  readonly handle: number | null;
  readonly rootPid: number;
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly incomplete: boolean;
  readonly processes: readonly {
    readonly pid: number;
    readonly parentPid: number;
    readonly name: string;
    readonly cpuPercent: number | null;
    readonly memoryBytes: number | null;
  }[];
}
export interface ResourceSnapshot {
  readonly supported: boolean;
  readonly groups: readonly ResourceGroup[];
  readonly history: readonly { readonly at: number; readonly groups: readonly Omit<ResourceGroup, "processes">[] }[];
  readonly exited: readonly { readonly handle: number; readonly pid: number; readonly observedAt: number }[];
  readonly error: string | null;
  readonly collectionMs?: number | null;
}

export interface MemorySample {
  readonly at: number;
  readonly bytes: number;
}
