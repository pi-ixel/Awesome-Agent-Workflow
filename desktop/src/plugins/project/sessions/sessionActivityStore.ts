import { createStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import type {
  SessionActivity,
  SessionActivityState,
} from "./indexTypes.ts";
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
export function createSessionActivityStore(signal: AbortSignal) {
  return createStore<
    SessionActivityState & {
      update: (entry: SessionActivity) => void;
      read: (project: string, id: string, agentKey?: string) => void;
      reset: () => void;
    }
  >()((set) => ({
    entries: {},
    update: (entry) =>
      set((state) => {
        if (signal.aborted) return state;
        const key = sessionActivityKey(
            entry.project,
            entry.sessionId,
            entry.agentKey,
          ),
          old = state.entries[key];
        if (
          old &&
          old.status === entry.status &&
          old.externallyManaged === entry.externallyManaged &&
          old.unread === entry.unread &&
          old.pending === entry.pending
        )
          return state;
        return { entries: { ...state.entries, [key]: entry } };
      }),
    read: (project, id, agentKey) =>
      set((state) => {
        if (signal.aborted) return state;
        const key = sessionActivityKey(project, id, agentKey);
        const entry = state.entries[key];
        return entry
          ? {
              entries: { ...state.entries, [key]: { ...entry, unread: false } },
            }
          : {};
      }),
    reset: () => set({ entries: {} }),
  }));
}
