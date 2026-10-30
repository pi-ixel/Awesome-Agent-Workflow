import { create } from "zustand";
import type { SessionSummary } from "./sessionStore.ts";

export type SessionListStatus =
  | { state: "loading" | "ready" | "unsupported" }
  | { state: "error"; message: string };

/** Selected Agent's sidebar catalog; independent of the focused working session. */
export const useSessionCatalogStore = create<{
  agentKey: string | null;
  sessionsByPath: Readonly<Record<string, readonly SessionSummary[]>>;
  statusByPath: Readonly<Record<string, SessionListStatus>>;
}>(() => ({ agentKey: null, sessionsByPath: {}, statusByPath: {} }));
