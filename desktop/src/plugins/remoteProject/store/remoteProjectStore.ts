import { createStore } from "zustand";
import type { HostStorage } from "../../host/types.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import {
  formatRemoteProjectPath,
  normalizePath,
  parseRemoteProjectPath,
  pathKey,
} from "../../../shared/panelPaths.ts";
import type {
  RemoteProjectRecord,
  RemoteProjectStoreSnapshot,
} from "../types.ts";

const STORAGE_KEY = "aaw-desktop/remote-projects/v1";
const RECENT_DIR_LIMIT = 8;

interface PersistedRemoteProjects {
  readonly version: 1;
  readonly records: readonly RemoteProjectRecord[];
  readonly recentDirsByConnection: Readonly<Record<string, readonly string[]>>;
}

function cleanRemoteRoot(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "/") return "/";
  const normalized = normalizePath(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
  return normalized || "/";
}

function defaultProjectName(remoteRoot: string): string {
  const cleaned = cleanRemoteRoot(remoteRoot);
  if (cleaned === "/") return "/";
  return cleaned.split("/").filter(Boolean).at(-1) ?? cleaned;
}

function generateProjectId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `rp_${rand}`;
}

function readPersisted(storage: HostStorage): RemoteProjectStoreSnapshot {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { records: [], recentDirsByConnection: {} };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return { records: [], recentDirsByConnection: {} };
    }
    const candidate = parsed as Record<string, unknown>;
    const records: RemoteProjectRecord[] = [];
    if (Array.isArray(candidate["records"])) {
      for (const rawItem of candidate["records"] as unknown[]) {
        if (typeof rawItem !== "object" || rawItem === null) continue;
        const item = rawItem as Record<string, unknown>;
        const projectId = typeof item["projectId"] === "string" ? item["projectId"] : "";
        const connectionId =
          typeof item["connectionId"] === "string" ? item["connectionId"] : "";
        const rawRoot = typeof item["remoteRoot"] === "string" ? item["remoteRoot"] : "";
        if (!projectId.trim() || !connectionId.trim()) continue;
        const remoteRoot = cleanRemoteRoot(rawRoot);
        const workspacePath = formatRemoteProjectPath(projectId, remoteRoot);
        const rawCwd = item["agentCwd"];
        const rawName = item["name"];
        const rawCreatedAt = item["createdAt"];
        const rawLastOpenedAt = item["lastOpenedAt"];
        records.push({
          projectId,
          connectionId,
          remoteRoot,
          workspacePath,
          agentCwd:
            typeof rawCwd === "string" && rawCwd
              ? rawCwd
              : `remote-projects/${projectId}`,
          name:
            typeof rawName === "string" && rawName.trim()
              ? rawName.trim()
              : defaultProjectName(remoteRoot),
          createdAt:
            typeof rawCreatedAt === "string"
              ? rawCreatedAt
              : new Date().toISOString(),
          lastOpenedAt:
            typeof rawLastOpenedAt === "string"
              ? rawLastOpenedAt
              : new Date().toISOString(),
        });
      }
    }
    const recentDirsByConnection: Record<string, readonly string[]> = {};
    const rawRecent = candidate["recentDirsByConnection"];
    if (typeof rawRecent === "object" && rawRecent !== null) {
      for (const [connId, dirs] of Object.entries(
        rawRecent as Record<string, unknown>,
      )) {
        if (Array.isArray(dirs)) {
          recentDirsByConnection[connId] = dirs
            .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
            .map(cleanRemoteRoot)
            .slice(0, RECENT_DIR_LIMIT);
        }
      }
    }
    return { records, recentDirsByConnection };
  } catch {
    return { records: [], recentDirsByConnection: {} };
  }
}

function writePersisted(
  storage: HostStorage,
  snapshot: RemoteProjectStoreSnapshot,
  logger: Logger,
): void {
  try {
    const payload: PersistedRemoteProjects = {
      version: 1,
      records: snapshot.records,
      recentDirsByConnection: snapshot.recentDirsByConnection,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    logger.warn("远程项目记录持久化写入失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createRemoteProjectStore(storage: HostStorage, logger: Logger) {
  const store = createStore<RemoteProjectStoreSnapshot>(() =>
    readPersisted(storage),
  );
  const view = createSnapshotView(store, (state) => state);

  const persist = (next: RemoteProjectStoreSnapshot) => {
    store.setState(next);
    writePersisted(storage, next, logger);
  };

  const getById = (projectId: string): RemoteProjectRecord | null =>
    store.getState().records.find((r) => r.projectId === projectId) ?? null;

  const getByPath = (path: string): RemoteProjectRecord | null => {
    const parsed = parseRemoteProjectPath(path);
    if (!parsed) return null;
    return getById(parsed.projectId);
  };

  const listProjectsForConnection = (
    connectionId: string,
  ): readonly RemoteProjectRecord[] =>
    store.getState().records.filter((r) => r.connectionId === connectionId);

  const recordRecentDir = (connectionId: string, dirPath: string): void => {
    const id = connectionId.trim();
    if (!id) return;
    const cleaned = cleanRemoteRoot(dirPath);
    const state = store.getState();
    const existing = state.recentDirsByConnection[id] ?? [];
    const nextDirs = [cleaned, ...existing.filter((d) => d !== cleaned)].slice(
      0,
      RECENT_DIR_LIMIT,
    );
    persist({
      ...state,
      recentDirsByConnection: {
        ...state.recentDirsByConnection,
        [id]: nextDirs,
      },
    });
  };

  const addProject = (
    connectionId: string,
    remoteRoot: string,
    name?: string,
  ): RemoteProjectRecord => {
    const id = connectionId.trim();
    const cleanedRoot = cleanRemoteRoot(remoteRoot);
    const now = new Date().toISOString();
    const state = store.getState();
    const existing = state.records.find(
      (r) => r.connectionId === id && r.remoteRoot === cleanedRoot,
    );
    if (existing) {
      const updated: RemoteProjectRecord = {
        ...existing,
        name: name?.trim() || existing.name,
        lastOpenedAt: now,
      };
      persist({
        ...state,
        records: state.records.map((r) =>
          r.projectId === existing.projectId ? updated : r,
        ),
      });
      recordRecentDir(id, cleanedRoot);
      return updated;
    }

    const projectId = generateProjectId();
    const record: RemoteProjectRecord = {
      projectId,
      connectionId: id,
      remoteRoot: cleanedRoot,
      workspacePath: formatRemoteProjectPath(projectId, cleanedRoot),
      agentCwd: `remote-projects/${projectId}`,
      name: name?.trim() || defaultProjectName(cleanedRoot),
      createdAt: now,
      lastOpenedAt: now,
    };
    const nextDirs = [
      cleanedRoot,
      ...(state.recentDirsByConnection[id] ?? []).filter(
        (d) => d !== cleanedRoot,
      ),
    ].slice(0, RECENT_DIR_LIMIT);
    persist({
      records: [record, ...state.records],
      recentDirsByConnection: {
        ...state.recentDirsByConnection,
        [id]: nextDirs,
      },
    });
    return record;
  };

  const removeProjectByPath = (path: string): void => {
    const targetKey = pathKey(path);
    const parsed = parseRemoteProjectPath(path);
    const state = store.getState();
    const nextRecords = state.records.filter(
      (r) =>
        pathKey(r.workspacePath) !== targetKey &&
        (!parsed || r.projectId !== parsed.projectId),
    );
    if (nextRecords.length === state.records.length) return;
    persist({ ...state, records: nextRecords });
  };

  return {
    snapshot: view.snapshot,
    getById,
    getByPath,
    listProjectsForConnection,
    addProject,
    removeProjectByPath,
    recordRecentDir,
    dispose: () => view.dispose(),
  };
}
