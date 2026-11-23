import type { AcpConnectionDiagnostic } from "../acpConnection/types.ts";
import type { CaptureHealth } from "./capture/captureHealth.ts";

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
      diagnosticScope?: string;
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
  subscribeCaptureHealth?: (
    listener: (health: CaptureHealth) => void,
  ) => () => void;
  storage?: (request: StorageRequest) => Promise<StorageResponse>;
  onStorageCleaned?: (listener: () => void) => () => void;
  isNative(): boolean;
  status(): Promise<DiagnosticsStatus>;
  snapshot(): Promise<DiagnosticsSnapshot | null>;
  probeConnection(id: string): Promise<void>;
  resources(session?: DiagnosticSessionKey): Promise<ResourceSnapshot>;
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
  readonly desktopMemory?: DesktopMemoryPoint | null;
  readonly turnMemory?: DesktopTurnMemory | null;
}

export interface DiagnosticSessionKey {
  readonly scope: string;
  readonly sessionId: string;
}

export interface DesktopMemoryPoint {
  readonly at: number;
  readonly memory: {
    readonly total: number | null;
    readonly executable: number | null;
    readonly interface: number | null;
    readonly browser: number | null;
    readonly other: number | null;
  };
}

export interface DesktopTurnMemory {
  readonly session: DiagnosticSessionKey;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly before: DesktopMemoryPoint | null;
  readonly peak: DesktopMemoryPoint | null;
  readonly hasOverlap: boolean;
}

export interface MemorySample {
  readonly at: number;
  readonly bytes: number;
}
