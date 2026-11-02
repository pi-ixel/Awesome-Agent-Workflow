/** 全局会话归档覆盖层：独立于 ACP runtime，所有列表与操作共享同一份状态。 */
import { create } from "zustand";
import { pathKey } from "../core/panelPaths.ts";
import { createLogger } from "../core/logger.ts";
const logger = createLogger("session-archive-store");

interface SessionArchiveState {
  readonly archivedSessions: ReadonlySet<string>;
  readonly archiveSession: (workspacePath: string, sessionId: string) => void;
  readonly unarchiveSession: (workspacePath: string, sessionId: string) => void;
}

const ARCHIVED_SESSIONS_STORAGE_KEY = "aaw-desktop/archived-sessions.v1";

/** 归档覆盖层的键：pathKey 归一路径 + \u0000 分隔 + 会话 id。 */
export function sessionArchiveKey(
  workspacePath: string,
  sessionId: string,
): string {
  return `${pathKey(workspacePath)}\u0000${sessionId}`;
}

function loadArchivedSessions(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(ARCHIVED_SESSIONS_STORAGE_KEY);
    if (raw === null) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

function persistArchivedSessions(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      ARCHIVED_SESSIONS_STORAGE_KEY,
      JSON.stringify([...keys]),
    );
  } catch (error) {
    // 持久化失败不阻断归档生效（重启后回到上次落盘状态），仅记录
    logger.warn("写入会话归档覆盖层失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const createSessionArchiveStore = () =>
  create<SessionArchiveState>((set, get) => ({
    archivedSessions: loadArchivedSessions(),

    archiveSession: (workspacePath, sessionId) => {
      const key = sessionArchiveKey(workspacePath, sessionId);
      if (get().archivedSessions.has(key)) {
        return;
      }
      const next = new Set(get().archivedSessions);
      next.add(key);
      persistArchivedSessions(next);
      set({ archivedSessions: next });
      logger.info("会话已归档", { workspacePath, sessionId });
    },

    unarchiveSession: (workspacePath, sessionId) => {
      const key = sessionArchiveKey(workspacePath, sessionId);
      if (!get().archivedSessions.has(key)) {
        return;
      }
      const next = new Set(get().archivedSessions);
      next.delete(key);
      persistArchivedSessions(next);
      set({ archivedSessions: next });
      logger.info("会话取消归档", { workspacePath, sessionId });
    },
  }));

export const useSessionArchiveStore = createSessionArchiveStore();
