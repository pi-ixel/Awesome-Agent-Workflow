import { isAbsolutePath, pathKey } from "../../../shared/panelPaths.ts";
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

export function createProjectSessionIndexes(storage: HostStorage, logger?: Logger) {
  const scope = new AbortController();
  const deletions = createSessionDeletions(storage);
  const modelProbeStorageKey = "aaw-desktop/model-probe-sessions.v1";
  const modelProbeKey = ({
    workspacePath,
    agentKey,
    sessionId,
  }: DeleteSessionTarget) =>
    JSON.stringify([
      sessionAgentId(agentKey) ?? agentKey,
      pathKey(workspacePath),
      sessionId,
    ]);
  const modelProbes = new Set<string>();
  try {
    const saved: unknown = JSON.parse(
      storage.getItem(modelProbeStorageKey) ?? "[]",
    );
    if (Array.isArray(saved))
      for (const key of saved)
        if (typeof key === "string") modelProbes.add(key);
  } catch (error) {
    logger?.warn("读取模型探测会话记录失败", { error: String(error) });
  }
  const isModelProbe = (target: DeleteSessionTarget) =>
    modelProbes.has(modelProbeKey(target));
  const retainedSessions = (agent: string) => storage.managed?.retainedSessions?.(agent) ?? [];
  const catalog = createSessionCatalog(
    scope.signal,
    (target) => deletions.blocked(target) || isModelProbe(target),
    retainedSessions,
  );
  const deletionView = createSnapshotView(deletions.store, (state) => state);
  const activity = createSessionActivityStore(scope.signal, storage);
  const directoryStorageKey = "aaw-desktop/session-working-directories.v1";
  let workingDirectories: Record<string, unknown> = {};
  try {
    const saved: unknown = JSON.parse(storage.getItem(directoryStorageKey) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      workingDirectories = saved as Record<string, unknown>;
  } catch (error) {
    logger?.warn("读取会话工作目录失败", { error: String(error) });
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
    retainedSessions,
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
      const cwd = workingDirectories[sessionActivityKey(project, sessionId, agentKey)];
      return typeof cwd === "string" && isAbsolutePath(cwd) ? cwd : undefined;
    },
    rememberWorkingDirectory(project: string, agentKey: string, sessionId: string, cwd: string) {
      const key = sessionActivityKey(project, sessionId, agentKey);
      if (!isAbsolutePath(cwd) || pathKey(cwd) === pathKey(project) || workingDirectories[key] === cwd) return;
      workingDirectories[key] = cwd;
      saveWorkingDirectories();
    },
    forgetSessionMetadata({ workspacePath, agentKey, sessionId }: DeleteSessionTarget) {
      activity.getState().forget(workspacePath, sessionId, agentKey);
      const key = sessionActivityKey(workspacePath, sessionId, agentKey);
      if (!(key in workingDirectories)) return;
      delete workingDirectories[key];
      saveWorkingDirectories();
    },
    async forgetArchived(target: DeleteSessionTarget): Promise<void> {
      const state = archive.getState();
      const archivedSessions = new Set(state.archivedSessions);
      const metadata = { ...state.metadata };
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
        delete metadata[key];
      }
      storage.setItem(
        "aaw-desktop/archived-sessions.v1",
        JSON.stringify([...archivedSessions]),
      );
      storage.setItem(
        "aaw-desktop/archived-session-metadata.v1",
        JSON.stringify(metadata),
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
        metadata,
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
