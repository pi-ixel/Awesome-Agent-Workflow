import type { StoreApi } from "zustand";

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  /** Original Agent title, before any local rename. */
  readonly nativeTitle?: string;
  readonly updatedAt: string | null;
}

export type SessionListStatus =
  | { state: "loading" | "ready" | "unsupported" }
  | { state: "error"; message: string };

export interface SessionCatalogState {
  readonly agentKey: string | null;
  readonly sessionsByPath: Readonly<Record<string, readonly SessionSummary[]>>;
  readonly statusByPath: Readonly<Record<string, SessionListStatus>>;
}

export interface SessionActivity {
  readonly agentKey?: string;
  readonly project: string;
  readonly sessionId: string;
  readonly status:
    "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle";
  readonly unread: boolean;
  readonly pending: number;
}

export interface SessionActivityState {
  readonly entries: Readonly<Record<string, SessionActivity>>;
}

export interface ArchiveMetadata {
  readonly projectPath: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

export interface SessionArchiveState {
  readonly metadata: Readonly<Record<string, ArchiveMetadata>>;
  readonly notice: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly agentKey: string | null;
  } | null;
  readonly archivedSessions: ReadonlySet<string>;
  readonly dismissNotice: () => void;
  readonly archiveWithNotice: (
    workspacePath: string,
    sessionId: string,
  ) => void;
  readonly archiveSession: (
    workspacePath: string,
    sessionId: string,
    agentKey?: string | null,
  ) => void;
  readonly unarchiveSession: (
    workspacePath: string,
    sessionId: string,
    agentKey?: string | null,
  ) => void;
}

export type SessionSnapshot<State> = Pick<
  StoreApi<State>,
  "getState" | "getInitialState" | "subscribe"
>;

export interface ProjectSessionIndexes {
  readonly catalog: SessionSnapshot<SessionCatalogState>;
  readonly activity: SessionSnapshot<SessionActivityState>;
  readonly archive: SessionSnapshot<SessionArchiveState>;
}
