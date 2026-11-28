import { isAbsolutePath, pathKey, projectFolderPath } from "../../../shared/panelPaths.ts";
import {
  sameSessionAgent,
  sessionAgentId,
  createSessionDeletions,
} from "./sessionDeletion.ts";
import { createSessionGroups } from "./sessionGroups.ts";
import type { HostStorage } from "../../host/types.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createSessionCatalog } from "./catalog.ts";
import { createSessionActivityStore, sessionActivityKey } from "./sessionActivityStore.ts";
import type { DeleteSessionTarget } from "./sessionDeletion.ts";
import { createSessionArchiveStore } from "./sessionArchiveStore.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import { createSessionMetadata, type SessionRecords, type StoredListing } from "./sessionMetadata.ts";
import { bindNativeSessionTitles } from "./sessionTitles.ts";

function readOwnerKey(key: string): [string, string, string] | undefined {
  try {
    const input: unknown = JSON.parse(key);
    if (Array.isArray(input) && input.length === 3 && input.every((value) => typeof value === "string"))
      return input as [string, string, string];
  } catch {
    // 跳过不完整的浏览器旧配置键。
  }
}

export function createProjectSessionIndexes(storage: HostStorage, logger?: Logger, initial?: SessionRecords) {
  const scope = new AbortController();
  const metadata = initial && createSessionMetadata(storage, initial);
  bindNativeSessionTitles(metadata);
  const deletions = createSessionDeletions(storage);
  const modelProbeStorageKey = "aaw-desktop/model-probe-sessions.v1";
  const modelProbes = new Set<string>();
  const ownerKey = (project: string, agent: string, id: string) =>
    JSON.stringify([
      sessionAgentId(agent) ?? agent,
      pathKey(projectFolderPath(project)),
      id,
    ]);
  const modelProbeKey = ({ workspacePath, agentKey, sessionId }: DeleteSessionTarget) =>
    ownerKey(workspacePath, agentKey, sessionId);
  try {
    const saved: unknown = JSON.parse(
      storage.getItem(modelProbeStorageKey) ?? "[]",
    );
    if (Array.isArray(saved)) {
      for (const key of saved) {
        if (typeof key !== "string") continue;
        const value: unknown = JSON.parse(key);
        if (Array.isArray(value) && typeof value[0] === "string" &&
            typeof value[1] === "string" && typeof value[2] === "string") {
          modelProbes.add(ownerKey(value[1], value[0], value[2]));
        }
      }
    }
  } catch (error) {
    logger?.warn("读取模型探测会话记录失败", { error: String(error) });
  }
  const isModelProbe = (target: DeleteSessionTarget) =>
    modelProbes.has(modelProbeKey(target));
  const retainedSessions = (agent: string) => storage.managed?.retainedSessions?.(agent) ?? [];
  const deletionView = createSnapshotView(deletions.store, (state) => state);
  const activity = createSessionActivityStore(scope.signal, storage, metadata, initial?.records);
  const directoryStorageKey = "aaw-desktop/session-working-directories.v1";
  let workingDirectories: Record<string, unknown> = {};
  try {
    const saved: unknown = JSON.parse(storage.getItem(directoryStorageKey) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      workingDirectories = saved as Record<string, unknown>;
  } catch (error) {
    logger?.warn("读取会话工作目录失败", { error: String(error) });
  }
  const ownersKey = "aaw-desktop/session-project-owners.v1";
  let owners: Readonly<Record<string, string>> = {};
  const ownershipConflicts = new Set(initial?.conflicts.map((key) => JSON.stringify(key)));
  const isOwnershipUncertain = (project: string, agent: string, id: string) =>
    ownershipConflicts.has(ownerKey(project, agent, id));
  try {
    const saved: unknown = initial
      ? Object.fromEntries(initial.records.map((record) =>
          [ownerKey(record.project, record.agentId, record.sessionId), record.project]))
      : JSON.parse(storage.getItem(ownersKey) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      owners = Object.fromEntries(Object.entries(saved).filter(
        (entry): entry is [string, string] => !!readOwnerKey(entry[0]) && typeof entry[1] === "string" && isAbsolutePath(entry[1]),
      ));
    }
  } catch (error) {
    logger?.warn("读取会话项目归属失败", { error: String(error) });
  }
  const legacyOwners = new Map<string, string>();
  for (const key of Object.keys(workingDirectories)) {
    try {
      const [agent, project, id]: unknown[] = JSON.parse(key) as unknown[];
      if (typeof agent === "string" && typeof project === "string" && typeof id === "string")
        legacyOwners.set(ownerKey(project, agent, id), project);
    } catch {
      // 跳过无法恢复的旧键。
    }
  }
  const ownerOf = (project: string, agent: string, id: string) => {
    const key = ownerKey(project, agent, id);
    return owners[key] ?? legacyOwners.get(key) ??
      retainedSessions(agent).find((entry) => ownerKey(entry.project, agent, entry.sessionId) === key)?.project;
  };
  const catalog = createSessionCatalog(
    scope.signal,
    (target) => {
      const owner = ownerOf(target.workspacePath, target.agentKey, target.sessionId);
      return isOwnershipUncertain(target.workspacePath, target.agentKey, target.sessionId) ||
        (owner !== undefined && pathKey(owner) !== pathKey(target.workspacePath)) ||
        deletions.blocked(target) || isModelProbe(target);
    },
    retainedSessions,
    metadata?.list,
  );
  let writes = Promise.resolve();
  function claimSessionProject(project: string, agentKey: string, sessionId: string, cwd?: string): Promise<void> {
    const operation = writes.then(async () => {
      const owner = ownerOf(project, agentKey, sessionId);
      if (isOwnershipUncertain(project, agentKey, sessionId) ||
          (owner && pathKey(owner) !== pathKey(project)))
        throw new Error("该会话属于其他项目");
      if (metadata) {
        await storage.managed!.flushConfiguration?.();
        const failure = storage.managed!.configurationError?.();
        if (failure) throw new Error(failure);
        const value = cwd && isAbsolutePath(cwd) && pathKey(cwd) !== pathKey(projectFolderPath(project)) &&
          metadata.get(project, agentKey, sessionId)?.metadata.cwd !== cwd
          ? { kind: "cwd" as const, value: cwd }
          : undefined;
        await metadata.write(project, agentKey, sessionId, value);
        owners = { ...owners, [ownerKey(project, agentKey, sessionId)]: project };
        catalog.refreshVisibility();
        return;
      }
      const key = ownerKey(project, agentKey, sessionId);
      if (owners[key]) return;
      const next = { ...owners, [key]: project };
      const value = JSON.stringify(next);
      if (storage.setConfigurationItem) await storage.setConfigurationItem(ownersKey, value);
      else storage.setItem(ownersKey, value);
      owners = next;
      catalog.refreshVisibility();
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const saveWorkingDirectories = () =>
    storage.setItem(directoryStorageKey, JSON.stringify(workingDirectories));
  const archive = createSessionArchiveStore(
    storage,
    catalog.store.getState,
    scope.signal,
    logger,
    (path, id, agentKey) =>
      !!agentKey &&
      deletions.blocked({ workspacePath: path, sessionId: id, agentKey }),
    metadata && initial && { backend: metadata, initial: initial.records, claim: claimSessionProject },
  );
  const groups = createSessionGroups();
  const catalogView = createSnapshotView(catalog.store, (state) => state);
  const activityView = createSnapshotView(activity, ({ entries, unreadReplies }) => ({ entries, unreadReplies }));
  const archiveView = createSnapshotView(archive, ({ notice, archivedSessions, metadata }) => ({
    notice,
    archivedSessions,
    metadata,
  }));
  return {
    catalog,
    async saveListings(project: string, agentKey: string, sessions: readonly StoredListing[]) {
      if (!metadata || !sessions.length) return;
      const saved = await metadata.saveListings(project, agentKey, sessions);
      if (scope.signal.aborted || !saved.length) return;
      owners = {
        ...owners,
        ...Object.fromEntries(saved.map(({ sessionId }) => [ownerKey(project, agentKey, sessionId), project])),
      };
      catalog.refreshVisibility();
    },
    retainedSessions,
    ownerOf,
    isOwnershipUncertain,
    workflowOwner(cwd: string, sessionIds: readonly string[]) {
      const ids = new Set(sessionIds);
      const primary = pathKey(projectFolderPath(cwd));
      const matches = ([, root, id]: [string, string, string]) => root === primary && ids.has(id);
      if ([...ownershipConflicts].some((key) => matches(JSON.parse(key) as [string, string, string])))
        return null;
      let owner: { project: string; agentId: string } | undefined;
      for (const [key, project] of Object.entries(owners)) {
        const identity = readOwnerKey(key);
        if (!identity || !matches(identity)) continue;
        const [agentId] = identity;
        if (owner && (owner.agentId !== agentId || pathKey(owner.project) !== pathKey(project))) return null;
        owner = { project, agentId };
      }
      return owner;
    },
    claimSessionProject,
    finishSessionRecovery: storage.managed?.finishSessionRecovery,
    isModelProbe,
    rememberModelProbe(target: DeleteSessionTarget) {
      modelProbes.add(modelProbeKey(target));
      catalog.excludeSessions([target]);
      storage.setItem(modelProbeStorageKey, JSON.stringify([...modelProbes]));
    },
    deletions,
    deletionView: deletionView.snapshot,
    activity,
    archive,
    catalogView: catalogView.snapshot,
    activityView: activityView.snapshot,
    archiveView: archiveView.snapshot,
    groups,
    workingDirectory(project: string, agentKey: string, sessionId: string) {
      if (metadata) return metadata.get(project, agentKey, sessionId)?.metadata.cwd ?? undefined;
      const cwd = workingDirectories[sessionActivityKey(project, sessionId, agentKey)];
      return typeof cwd === "string" && isAbsolutePath(cwd) ? cwd : undefined;
    },
    rememberWorkingDirectory(project: string, agentKey: string, sessionId: string, cwd: string) {
      if (metadata) return; // 原生工作目录在确认会话归属时与身份一起登记。
      const key = sessionActivityKey(project, sessionId, agentKey);
      if (!isAbsolutePath(cwd) || pathKey(cwd) === pathKey(project) || workingDirectories[key] === cwd) return;
      workingDirectories[key] = cwd;
      saveWorkingDirectories();
    },
    forgetSessionMetadata({ workspacePath, agentKey, sessionId }: DeleteSessionTarget) {
      metadata?.forget(workspacePath, agentKey, sessionId);
      activity.getState().forget(workspacePath, sessionId, agentKey);
      if (metadata) return;
      const key = sessionActivityKey(workspacePath, sessionId, agentKey);
      if (!(key in workingDirectories)) return;
      delete workingDirectories[key];
      saveWorkingDirectories();
    },
    async forgetArchived(target: DeleteSessionTarget): Promise<void> {
      const state = archive.getState();
      const archivedSessions = new Set(state.archivedSessions);
      const archiveMetadata = { ...state.metadata };
      for (const key of [...archivedSessions]) {
        const [path, id, encoded] = key.split("\0");
        if (path !== pathKey(target.workspacePath) || id !== target.sessionId)
          continue;
        if (encoded) {
          let owner: string;
          try {
            owner = decodeURIComponent(encoded);
          } catch {
            continue;
          }
          if (!sameSessionAgent(owner, target.agentKey)) continue;
        }
        archivedSessions.delete(key);
        delete archiveMetadata[key];
      }
      if (!metadata) storage.setItem(
        "aaw-desktop/archived-sessions.v1",
        JSON.stringify([...archivedSessions]),
      );
      if (!metadata) storage.setItem(
        "aaw-desktop/archived-session-metadata.v1",
        JSON.stringify(archiveMetadata),
      );
      await (storage.managed?.flushConfiguration?.() ?? storage.managed?.flush?.());
      const error = storage.managed?.configurationError?.();
      if (error) throw new Error(error);
      if (
        archive.getState().archivedSessions !== state.archivedSessions ||
        archive.getState().metadata !== state.metadata
      )
        return this.forgetArchived(target);
      const notice = state.notice;
      archive.setState({
        archivedSessions,
        metadata: archiveMetadata,
        notice:
          notice &&
          pathKey(notice.workspacePath) === pathKey(target.workspacePath) &&
          notice.sessionId === target.sessionId
            ? null
            : notice,
      });
    },
    dispose() {
      if (scope.signal.aborted) return;
      scope.abort();
      catalog.resetCatalog();
      activity.getState().reset();
      archive.setState({
        notice: null,
        archivedSessions: new Set(),
        metadata: {},
      });
      groups.dispose();
      deletionView.dispose();
      catalogView.dispose();
      activityView.dispose();
      archiveView.dispose();
    },
  };
}
