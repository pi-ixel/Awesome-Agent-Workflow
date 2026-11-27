import { createStore } from "zustand";
import type { HostStorage } from "../../host/types.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import {
  formatRemoteProjectPath,
  normalizePath,
  parseRemoteProjectPath,
} from "../../../shared/panelPaths.ts";
import type {
  RemoteProjectRecord,
  RemoteProjectGroup,
  SaveRemoteProjectGroup,
  RemoteProjectStoreSnapshot,
} from "../types.ts";

export const remoteProjectsKey = "aaw-desktop/remote-projects/v1";
const RECENT_DIR_LIMIT = 8;

interface PersistedRemoteProjects {
  readonly version: 1;
  readonly records: readonly RemoteProjectRecord[];
  readonly recentDirsByConnection: Readonly<Record<string, readonly string[]>>;
}

function cleanRemoteRoot(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "/") return "/";
  const normalized = normalizePath(
    trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
  );
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
    const raw = storage.getItem(remoteProjectsKey);
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
        const projectId =
          typeof item["projectId"] === "string" ? item["projectId"] : "";
        const connectionId =
          typeof item["connectionId"] === "string" ? item["connectionId"] : "";
        const rawRoot =
          typeof item["remoteRoot"] === "string" ? item["remoteRoot"] : "";
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
          ...(item["associationOnly"] === true && { associationOnly: true }),
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
            .filter(
              (d): d is string => typeof d === "string" && d.trim().length > 0,
            )
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

export function createRemoteProjectStore(storage: HostStorage, logger: Logger) {
  const store = createStore<RemoteProjectStoreSnapshot>(() =>
    readPersisted(storage),
  );
  const view = createSnapshotView(store, (state) => state);

  let pending = Promise.resolve();
  // 每次从上一次成功保存的状态计算，失败的项目不会混入后续写入。
  function enqueue<T>(change: () => T | Promise<T>): Promise<T> {
    const result = pending.then(change);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function serialize(next: RemoteProjectStoreSnapshot): string {
    const payload: PersistedRemoteProjects = { version: 1, ...next };
    return JSON.stringify(payload);
  }
  async function persist(next: RemoteProjectStoreSnapshot) {
    const value = serialize(next);
    if (storage.setConfigurationItem)
      await storage.setConfigurationItem(remoteProjectsKey, value);
    else storage.setItem(remoteProjectsKey, value);
    store.setState(next);
  }

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
    store
      .getState()
      .records.filter(
        (r) => r.connectionId === connectionId && !r.associationOnly,
      );

  function recentWith(
    state: RemoteProjectStoreSnapshot,
    connectionId: string,
    remoteRoot: string,
  ) {
    const previous = state.recentDirsByConnection[connectionId] ?? [];
    return {
      ...state.recentDirsByConnection,
      [connectionId]: [
        remoteRoot,
        ...previous.filter((dir) => dir !== remoteRoot),
      ].slice(0, RECENT_DIR_LIMIT),
    };
  }

  function recordRecentDir(
    connectionId: string,
    dirPath: string,
  ): Promise<void> {
    const id = connectionId.trim();
    if (!id) return Promise.resolve();
    const remoteRoot = cleanRemoteRoot(dirPath);
    return enqueue(async () => {
      const state = store.getState();
      if (state.recentDirsByConnection[id]?.[0] === remoteRoot) return;
      await persist({
        ...state,
        recentDirsByConnection: recentWith(state, id, remoteRoot),
      });
    }).catch((error: unknown) => {
      logger.warn("远程目录历史保存失败", { error: String(error) });
    });
  }

  function saveProjectGroup(
    connectionId: string,
    remoteRoot: string,
    name: string | undefined,
    relatedRoots: readonly string[],
    repairPath?: string,
    save?: SaveRemoteProjectGroup,
  ): Promise<RemoteProjectGroup> {
    return enqueue(async () => {
      const id = connectionId.trim();
      const cleanedRoot = cleanRemoteRoot(remoteRoot);
      const now = new Date().toISOString();
      const state = store.getState();
      const repair = repairPath ? parseRemoteProjectPath(repairPath) : null;
      if (!id || (repairPath && repair?.remotePath !== cleanedRoot)) {
        throw new Error("无效的远程项目连接或目录");
      }
      const existing = state.records.find((record) =>
        repair
          ? record.projectId === repair.projectId
          : record.connectionId === id && record.remoteRoot === cleanedRoot,
      );
      if (
        repair &&
        existing &&
        (existing.connectionId !== id || existing.remoteRoot !== cleanedRoot)
      ) {
        throw new Error("该项目的连接已恢复，请重新打开项目");
      }
      const projectId =
        existing?.projectId ?? repair?.projectId ?? generateProjectId();
      const record: RemoteProjectRecord = {
        projectId,
        connectionId: id,
        remoteRoot: cleanedRoot,
        workspacePath: formatRemoteProjectPath(projectId, cleanedRoot),
        agentCwd: existing?.agentCwd ?? `remote-projects/${projectId}`,
        name: name?.trim() || existing?.name || defaultProjectName(cleanedRoot),
        createdAt: existing?.createdAt ?? now,
        lastOpenedAt: now,
      };
      const records = existing
        ? state.records.map((item) =>
            item.projectId === projectId ? record : item,
          )
        : [record, ...state.records];
      const relatedPaths: string[] = [];
      for (const root of new Set(relatedRoots.map(cleanRemoteRoot))) {
        if (root === cleanedRoot) continue;
        let child = records.find(
          (item) => item.connectionId === id && item.remoteRoot === root,
        );
        if (!child) {
          const childId = generateProjectId();
          child = {
            ...record,
            projectId: childId,
            remoteRoot: root,
            workspacePath: formatRemoteProjectPath(childId, root),
            agentCwd: `remote-projects/${childId}`,
            name: defaultProjectName(root),
            createdAt: now,
            associationOnly: true,
          };
          records.push(child);
        }
        relatedPaths.push(child.workspacePath);
      }
      const next = {
        records,
        recentDirsByConnection: recentWith(state, id, cleanedRoot),
      };
      const group = { record, relatedPaths };
      if (save) await save(group, { [remoteProjectsKey]: serialize(next) }, () => store.setState(next));
      else await persist(next);
      return group;
    });
  }

  async function addProject(
    connectionId: string,
    remoteRoot: string,
    name?: string,
    repairPath?: string,
  ): Promise<RemoteProjectRecord> {
    return (
      await saveProjectGroup(connectionId, remoteRoot, name, [], repairPath)
    ).record;
  }

  function repairProjectGroup(
    path: string,
    connectionId: string,
    relatedPaths: readonly string[],
    checkDirectory: (root: string) => Promise<void>,
  ): Promise<RemoteProjectRecord> {
    return enqueue(async () => {
      const id = connectionId.trim();
      const state = store.getState();
      const now = new Date().toISOString();
      const records = [path, ...relatedPaths].map<RemoteProjectRecord>((folder, index) => {
        const target = parseRemoteProjectPath(folder);
        if (!id || !target) throw new Error("无效的远程项目连接或目录");
        const { projectId, remotePath: remoteRoot } = target;
        const existing = getById(projectId);
        if (
          existing &&
          (existing.connectionId !== id || existing.remoteRoot !== remoteRoot)
        )
          throw new Error("请使用项目中已绑定的 SSH 连接");
        return existing ?? {
          projectId,
          connectionId: id,
          remoteRoot,
          workspacePath: formatRemoteProjectPath(projectId, remoteRoot),
          agentCwd: `remote-projects/${projectId}`,
          name: defaultProjectName(remoteRoot),
          createdAt: now,
          lastOpenedAt: now,
          ...(index > 0 && { associationOnly: true }),
        };
      });
      const [primary] = records;
      if (
        !primary ||
        new Set(records.map(({ projectId }) => projectId)).size !== records.length
      )
        throw new Error("远程项目目录记录重复");
      const missing = records.filter(({ projectId }) => !getById(projectId));
      if (!missing.length) throw new Error("该项目无需修复，请重新打开项目");
      await Promise.all(records.map(({ remoteRoot }) => checkDirectory(remoteRoot)));
      await persist({
        records: [...missing, ...state.records],
        recentDirsByConnection: recentWith(state, id, primary.remoteRoot),
      });
      return primary;
    });
  }

  function removeProjectByPath(
    path: string,
    retainAssociation = false,
  ): Promise<void> {
    const parsed = parseRemoteProjectPath(path);
    if (!parsed) return Promise.resolve();
    return enqueue(async () => {
      const state = store.getState();
      if (
        !state.records.some((record) => record.projectId === parsed.projectId)
      )
        return;
      const nextRecords = retainAssociation
        ? state.records.map((record): RemoteProjectRecord =>
            record.projectId === parsed.projectId
              ? { ...record, associationOnly: true }
              : record,
          )
        : state.records.filter(
            (record) => record.projectId !== parsed.projectId,
          );
      await persist({ ...state, records: nextRecords });
    });
  }

  function removeConnectionMetadata(connectionId: string): Promise<void> {
    return enqueue(async () => {
      const state = store.getState();
      const { [connectionId]: directories, ...recentDirsByConnection } =
        state.recentDirsByConnection;
      const records = state.records.filter(
        (record) =>
          record.connectionId !== connectionId || !record.associationOnly,
      );
      if (directories || records.length !== state.records.length)
        await persist({ records, recentDirsByConnection });
    });
  }

  return {
    snapshot: view.snapshot,
    getById,
    getByPath,
    listProjectsForConnection,
    addProject,
    saveProjectGroup,
    repairProjectGroup,
    removeProjectByPath,
    removeConnectionMetadata,
    recordRecentDir,
    dispose: () => view.dispose(),
  };
}
