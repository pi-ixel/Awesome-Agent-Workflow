import { createStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { HostStorage } from "../../host/types.ts";
import { sameSessionAgent } from "./sessionDeletion.ts";
import type {
  SessionActivity,
  SessionActivityState,
  UnreadSessionReply,
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
const unreadStorageKey = "aaw-desktop/session-unread-replies.v1";

function unreadReplyKey(project: string, sessionId: string, agentId: string) {
  return sessionActivityKey(project, sessionId, agentId);
}

function loadUnreadReplies(
  storage?: HostStorage,
): Record<string, UnreadSessionReply> {
  try {
    const saved: unknown = JSON.parse(
      storage?.getItem(unreadStorageKey) ?? "[]",
    );
    if (!Array.isArray(saved)) return {};
    const replies: Record<string, UnreadSessionReply> = {};
    for (const value of saved as readonly unknown[]) {
      if (!value || typeof value !== "object") continue;
      const { agentId, agentKey, project, sessionId } = value as Record<
        string,
        unknown
      >;
      if (
        typeof agentId !== "string" ||
        typeof agentKey !== "string" ||
        typeof project !== "string" ||
        typeof sessionId !== "string"
      )
        continue;
      replies[unreadReplyKey(project, sessionId, agentId)] = {
        agentId,
        agentKey,
        project,
        sessionId,
      };
    }
    return replies;
  } catch {
    return {};
  }
}

export function createSessionActivityStore(
  signal: AbortSignal,
  storage?: HostStorage,
) {
  function saveUnreadReplies(replies: SessionActivityState["unreadReplies"]) {
    storage?.setItem(unreadStorageKey, JSON.stringify(Object.values(replies)));
    return replies;
  }

  function clearUnreadReply(
    state: SessionActivityState,
    project: string,
    id: string,
    agentKey?: string,
  ) {
    const entry = Object.entries(state.unreadReplies).find(
      ([, reply]) =>
        agentKey !== undefined &&
        reply.sessionId === id &&
        pathKey(reply.project) === pathKey(project) &&
        sameSessionAgent(reply.agentKey, agentKey),
    );
    if (!entry) return state.unreadReplies;
    const replies = { ...state.unreadReplies };
    delete replies[entry[0]];
    return saveUnreadReplies(replies);
  }

  return createStore<
    SessionActivityState & {
      update: (
        entry: SessionActivity,
        reply?: { agentId: string; unreadReply?: boolean },
      ) => void;
      read: (project: string, id: string, agentKey?: string) => void;
      forget: (project: string, id: string, agentKey: string) => void;
      reset: () => void;
    }
  >()((set) => ({
    entries: {},
    unreadReplies: loadUnreadReplies(storage),
    update: (entry, reply) =>
      set((state) => {
        if (signal.aborted) return state;
        const { project, sessionId, agentKey } = entry;
        const key = sessionActivityKey(project, sessionId, agentKey);
        const old = state.entries[key];
        let unreadReplies = state.unreadReplies;
        if (agentKey && reply?.unreadReply !== undefined) {
          const replyKey = unreadReplyKey(project, sessionId, reply.agentId);
          const hasReply = Boolean(unreadReplies[replyKey]);
          if (hasReply !== reply.unreadReply) {
            const replies = { ...unreadReplies };
            if (reply.unreadReply)
              replies[replyKey] = {
                agentId: reply.agentId,
                agentKey,
                project,
                sessionId,
              };
            else delete replies[replyKey];
            unreadReplies = saveUnreadReplies(replies);
          }
        }
        if (
          old &&
          old.status === entry.status &&
          old.externallyManaged === entry.externallyManaged &&
          old.unread === entry.unread &&
          old.pending === entry.pending
        )
          return unreadReplies === state.unreadReplies
            ? state
            : { unreadReplies };
        return { entries: { ...state.entries, [key]: entry }, unreadReplies };
      }),
    read: (project, id, agentKey) =>
      set((state) => {
        if (signal.aborted) return state;
        const key = sessionActivityKey(project, id, agentKey);
        const entry = state.entries[key];
        const unreadReplies = clearUnreadReply(state, project, id, agentKey);
        if (!entry?.unread)
          return unreadReplies === state.unreadReplies
            ? state
            : { unreadReplies };
        return {
          entries: { ...state.entries, [key]: { ...entry, unread: false } },
          unreadReplies,
        };
      }),
    forget: (project, id, agentKey) =>
      set((state) => {
        if (signal.aborted) return state;
        const key = sessionActivityKey(project, id, agentKey);
        const unreadReplies = clearUnreadReply(state, project, id, agentKey);
        if (!state.entries[key])
          return unreadReplies === state.unreadReplies
            ? state
            : { unreadReplies };
        const entries = { ...state.entries };
        delete entries[key];
        return { entries, unreadReplies };
      }),
    reset: () => set({ entries: {} }),
  }));
}
