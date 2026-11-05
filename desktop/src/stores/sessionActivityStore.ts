import { create } from "zustand";
import { pathKey } from "../core/panelPaths.ts";
export type SessionActivity = {
  agentKey?: string;
  project: string;
  sessionId: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle";
  unread: boolean;
  pending: number;
};
export const sessionActivityKey = (
  project: string,
  id: string,
  agentKey?: string,
) =>
  JSON.stringify(
    agentKey === undefined
      ? [pathKey(project), id]
      : [agentKey, pathKey(project), id],
  );
export const useSessionActivityStore = create<{
  entries: Record<string, SessionActivity>;
  update: (entry: SessionActivity) => void;
  read: (project: string, id: string, agentKey?: string) => void;
  reset: () => void;
}>((set) => ({
  entries: {},
  update: (entry) =>
    set((state) => {
      const key = sessionActivityKey(
          entry.project,
          entry.sessionId,
          entry.agentKey,
        ),
        old = state.entries[key];
      if (
        old &&
        old.status === entry.status &&
        old.unread === entry.unread &&
        old.pending === entry.pending
      )
        return state;
      return { entries: { ...state.entries, [key]: entry } };
    }),
  read: (project, id, agentKey) =>
    set((state) => {
      const key = sessionActivityKey(project, id, agentKey);
      const entry = state.entries[key];
      return entry
        ? { entries: { ...state.entries, [key]: { ...entry, unread: false } } }
        : {};
    }),
  reset: () => set({ entries: {} }),
}));
