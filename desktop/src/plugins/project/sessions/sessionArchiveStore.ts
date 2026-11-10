import type { HostStorage } from "../../host/types.ts";
import type {
  ArchiveMetadata,
  SessionArchiveState,
  SessionCatalogState,
} from "./indexTypes.ts";
import { createStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";

const METADATA_KEY = "aaw-desktop/archived-session-metadata.v1";
function loadMetadata(storage: HostStorage): Record<string, ArchiveMetadata> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(METADATA_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]: [string, unknown]) => {
        if (!v || typeof v !== "object") return false;
        const m = v as Partial<ArchiveMetadata>;
        return (
          typeof m.projectPath === "string" &&
          typeof m.title === "string" &&
          (m.updatedAt === null || typeof m.updatedAt === "string")
        );
      }),
    );
  } catch {
    return {};
  }
}
function persistMetadata(
  storage: HostStorage,
  metadata: Readonly<Record<string, ArchiveMetadata>>,
  logger: Logger,
): void {
  try {
    storage.setItem(METADATA_KEY, JSON.stringify(metadata));
  } catch (error) {
    logger.warn("归档元数据保存失败", { error: String(error) });
  }
}

const ARCHIVED_SESSIONS_STORAGE_KEY = "aaw-desktop/archived-sessions.v1";

/** 归档覆盖层的键：pathKey 归一路径 + \u0000 分隔 + 会话 id。 */
export function sessionArchiveKey(
  workspacePath: string,
  sessionId: string,
  agentKey?: string | null,
): string {
  const legacy = `${pathKey(workspacePath)}\u0000${sessionId}`;
  return agentKey == null
    ? legacy
    : `${legacy}\u0000${encodeURIComponent(agentKey)}`;
}

function loadArchivedSessions(storage: HostStorage): ReadonlySet<string> {
  try {
    const raw = storage.getItem(ARCHIVED_SESSIONS_STORAGE_KEY);
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

function persistArchivedSessions(
  storage: HostStorage,
  keys: ReadonlySet<string>,
  logger: Logger,
): void {
  try {
    storage.setItem(ARCHIVED_SESSIONS_STORAGE_KEY, JSON.stringify([...keys]));
  } catch (error) {
    // 持久化失败不阻断归档生效（重启后回到上次落盘状态），仅记录
    logger.warn("写入会话归档覆盖层失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createSessionArchiveStore(
  storage: HostStorage,
  readCatalog: () => SessionCatalogState,
  signal: AbortSignal,
  logger = createLogger("session-archive-store"),
) {
  return createStore<SessionArchiveState>()((set, get) => ({
    archivedSessions: loadArchivedSessions(storage),
    metadata: loadMetadata(storage),
    notice: null,
    dismissNotice: () => {
      if (!signal.aborted) set({ notice: null });
    },
    archiveWithNotice: (workspacePath, sessionId) => {
      if (signal.aborted) return;
      const agentKey = readCatalog().agentKey;
      get().archiveSession(workspacePath, sessionId, agentKey);
      set({
        notice: {
          workspacePath,
          sessionId,
          agentKey,
        },
      });
    },

    archiveSession: (workspacePath, sessionId, agentKey) => {
      if (signal.aborted) return;
      const catalog = readCatalog();
      const owner = agentKey === undefined ? catalog.agentKey : agentKey;
      const key = sessionArchiveKey(workspacePath, sessionId, owner);
      if (get().archivedSessions.has(key)) {
        return;
      }
      const next = new Set(get().archivedSessions);
      next.add(key);
      const cached =
        owner === catalog.agentKey
          ? Object.entries(catalog.sessionsByPath).find(
              ([path]) => pathKey(path) === pathKey(workspacePath),
            )
          : undefined;
      const session = cached?.[1].find((entry) => entry.id === sessionId);
      const metadata = {
        ...get().metadata,
        [key]: {
          projectPath: cached?.[0] ?? workspacePath,
          title: session?.title ?? "会话",
          updatedAt: session?.updatedAt ?? null,
        },
      };
      persistMetadata(storage, metadata, logger);
      persistArchivedSessions(storage, next, logger);
      set({ archivedSessions: next, metadata });
      logger.info("会话已归档", { workspacePath, sessionId });
    },

    unarchiveSession: (workspacePath, sessionId, agentKey) => {
      if (signal.aborted) return;
      const key = sessionArchiveKey(
        workspacePath,
        sessionId,
        agentKey === undefined ? readCatalog().agentKey : agentKey,
      );
      if (!get().archivedSessions.has(key)) {
        return;
      }
      const next = new Set(get().archivedSessions);
      next.delete(key);
      persistArchivedSessions(storage, next, logger);
      const metadata = { ...get().metadata };
      delete metadata[key];
      persistMetadata(storage, metadata, logger);
      set({
        archivedSessions: next,
        metadata,
        ...(get().notice &&
        sessionArchiveKey(
          get().notice!.workspacePath,
          get().notice!.sessionId,
          get().notice!.agentKey,
        ) === key
          ? { notice: null }
          : {}),
      });
      logger.info("会话取消归档", { workspacePath, sessionId });
    },
  }));
}
