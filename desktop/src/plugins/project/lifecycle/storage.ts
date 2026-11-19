import { SESSION_LOG_ITEM_LIMIT } from "../conversation/sessionStore.ts";
import { nativePromptQueue, nativeSnapshots, sessionLogPrefix } from "../conversation/snapshotStorage.ts";
import { queuePrefix } from "../conversation/queuePersistence.ts";
import { isSessionTitleKey, loadSessionTitles, migratedSessionTitle, nativeSessionTitleBytes, sessionTitleMigrationFailure } from "../sessions/sessionTitles.ts";
import { managedProjectStorage, projectStorage } from "./persistence.ts";
import { MAX_ENTRIES } from "../composer/promptHistory.ts";
import type {
  StorageCategory,
  StorageItem,
} from "../../diagnostics/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { ProjectRuntimeDebugEntry } from "../types.ts";

export function conversationScope(scope: string): {
  agent?: string;
  project?: string;
  session?: string;
} {
  let agent: string | undefined;
  if (scope.startsWith("[")) {
    const tuple: unknown = JSON.parse(scope);
    if (
      !Array.isArray(tuple) ||
      typeof tuple[0] !== "string" ||
      typeof tuple[1] !== "string"
    )
      return {};
    agent = tuple[0];
    scope = tuple[1];
  }
  const separator = scope.lastIndexOf("#");
  return separator < 0
    ? {}
    : {
        agent,
        project: scope.slice(0, separator),
        session: scope.slice(separator + 1),
      };
}

export function draftScope(scope: string) {
  const parts = scope.split("/");
  if (parts[2] === "v2" && parts.length >= 6)
    return {
      agent: decodeURIComponent(parts[3]!),
      project: decodeURIComponent(parts[4]!),
      session: decodeURIComponent(parts[5]!),
    };
  return {
    project: parts[2] && decodeURIComponent(parts[2]),
    session: parts[3] && decodeURIComponent(parts[3]),
  };
}

export function createProjectStorageProtection(
  runtime: () => readonly ProjectRuntimeDebugEntry[],
  activeProject: () => string | null,
) {
  const reason = ({
    project,
    session,
  }: {
    project?: string;
    session?: string;
  }): string | undefined => {
    if (!project) return "历史数据归属待确认";
    const current = activeProject();
    if (
      current &&
      pathKey(current) === pathKey(project) &&
      (!session || session === "__new__")
    )
      return "项目输入区正在使用";
    const entries = runtime().filter(
      (entry) =>
        pathKey(entry.workspacePath) === pathKey(project) &&
        !entry.listOnly &&
        (!session || !entry.sessionId || entry.sessionId === session),
    );
    if (entries.some((entry) => entry.isAgentRunning)) return "任务运行中";
    if (entries.some((entry) => entry.queuedPrompts > 0)) return "有待发送消息";
    if (entries.some((entry) => entry.pendingApprovals > 0)) return "等待审批";
    if (entries.length) return "会话已打开";
    return undefined;
  };
  return Object.assign(
    (target: { project?: string; session?: string }) => !!reason(target),
    { reason },
  );
}

export function projectStorageCategories(
  isProtected: ReturnType<typeof createProjectStorageProtection>,
): StorageCategory[] {
  function category(
    id: string,
    label: string,
    risk: string,
    match: (key: string) => boolean,
    scope: (key: string) => ReturnType<typeof conversationScope>,
  ): StorageCategory {
    function entry(key: string, value: string): StorageItem {
      let target;
      try {
        target = scope(key);
      } catch {
        target = {};
      }
      const { agent, project } = target;
      return {
        key,
        agent,
        project,
        bytes: (key.length + value.length) * 2,
        revision: value,
        protected: isProtected(target),
        protectedReason: isProtected.reason(target),
      };
    }
    return {
      id,
      label,
      threshold:
        id === "project.session-cache"
          ? SESSION_LOG_ITEM_LIMIT + " 项 / 会话"
          : id === "project.prompt-history"
            ? MAX_ENTRIES + " 条 / 会话"
            : undefined,
      risk,
      list() {
        const rows: StorageItem[] = [];
        const managed = managedProjectStorage();
        const keys = managed?.available() ? managed.conversationKeys() : Object.keys(localStorage);
        for (const key of keys) {
          if (!key || !match(key)) continue;
          const value = projectStorage.getItem(key);
          if (value !== null) rows.push(entry(key, value));
        }
        return rows;
      },
      async remove(item) {
        const current = projectStorage.getItem(item.key);
        if (
          current === null ||
          current !== item.revision ||
          entry(item.key, current).protected
        )
          return false;
        projectStorage.removeItem?.(item.key);
        const managed = managedProjectStorage();
        if (managed?.available() && managed.isManagedKey(item.key)) {
          await managed.flush();
          const error = managed.conversationError();
          if (error) throw new Error(error);
        }
        return true;
      },
    };
  }
  const scoped = (prefix: string) => (key: string) =>
    conversationScope(decodeURIComponent(key.slice(prefix.length)));
  const logs = sessionLogPrefix;
  const queue = queuePrefix;
  const draft = "aaw-desktop/draft/";
  const history = "aaw-desktop/prompt-history/";
  const annotation = "/document-annotations-v1";
  function nativeCategory(
    id: string, label: string, risk: string, storage: typeof nativeSnapshots, threshold?: string,
  ): StorageCategory {
    return {
      id, label, risk, threshold, exact: true,
      async list() {
        return (await storage.list()).map((item) => {
          const scope = conversationScope(item.key);
          return { ...item, ...scope, protected: isProtected(scope), protectedReason: isProtected.reason(scope) };
        });
      },
      remove(item) {
        if (isProtected(conversationScope(item.key))) return false;
        return storage.remove(item);
      },
    };
  }
  return [
    {
      id: "project.session-metadata",
      label: "会话标题、置顶与归档",
      risk: "",
      list() {
        const rows: StorageItem[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (
            !key ||
            !/^aaw-desktop\/(?:session-title(?:\.v2)?\/|archived-session(?:s|-metadata)\.v1$)/.test(
              key,
            ) || (nativeSnapshots.available() && migratedSessionTitle(key))
          )
            continue;
          const value = localStorage.getItem(key);
          if (value !== null)
            rows.push({
              key,
              bytes: (key.length + value.length) * 2,
              revision: value,
            });
        }
        const titleBytes = nativeSessionTitleBytes();
        if (titleBytes !== undefined) rows.push({ key: "native-session-titles", bytes: titleBytes, revision: null });
        const workspace = projectStorage.getItem("aaw-desktop/workspace/v1");
        if (workspace) {
          const { pinnedSessions } = JSON.parse(workspace) as { pinnedSessions?: unknown };
          if (Array.isArray(pinnedSessions) && pinnedSessions.length)
            rows.push({
              key: "pinnedSessions",
              bytes: JSON.stringify(pinnedSessions).length * 2,
              revision: null,
            });
        }
        return rows;
      },
    },
    nativeSnapshots.available() ? nativeCategory(
      "project.session-cache", "会话快照", "删除本地回放缓存。重新打开时将从 Agent 加载历史。",
      nativeSnapshots, SESSION_LOG_ITEM_LIMIT + " 项 / 会话",
    ) : category(
      "project.session-cache",
      "会话快照",
      "删除本地回放缓存。重新打开时将从 Agent 加载历史。",
      (key) => key.startsWith(logs),
      scoped(logs),
    ),
    nativePromptQueue.available() ? nativeCategory(
      "project.queue", "待发送队列", "清理后，这些未发送消息将永久丢失。", nativePromptQueue,
    ) : category(
      "project.queue",
      "待发送队列",
      "清理后，这些未发送消息将永久丢失。",
      (key) => key.startsWith(queue),
      scoped(queue),
    ),
    category(
      "project.draft",
      "文字草稿",
      "清理后，这些未发送的文字将永久丢失。",
      (key) =>
        key.startsWith(draft) &&
        /^aaw-desktop\/draft\/(?:v2\/[^/]+\/)?[^/]+\/[^/]+$/.test(key),
      draftScope,
    ),
    category(
      "project.annotations",
      "批注草稿",
      "清理后，这些批注和本地提交记录将永久丢失。",
      (key) => key.startsWith(draft) && key.endsWith(annotation),
      draftScope,
    ),
    category(
      "project.prompt-history",
      "提示词历史",
      "清理后，将无法从输入历史找回这些内容。",
      (key) => key.startsWith(history),
      draftScope,
    ),
  ];
}

export function createLegacyStorage(imageSources: readonly {
  prefix: string;
  legacyEntries(): readonly StorageItem[];
  removeLegacy(key: string, revision: unknown): Promise<boolean>;
}[]): { category: StorageCategory; migrate(): Promise<void> } {
  const verified = new Set<string>();
  let error: string | undefined;
  let running: Promise<void> | undefined;
  function migrate(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let failed = 0;
      let reason = "";
      try {
        await loadSessionTitles();
        await managedProjectStorage()?.load();
        for (const key of Object.keys(localStorage)) {
          const prefix = [sessionLogPrefix, queuePrefix].find((value) => key.startsWith(value));
          if (!prefix) continue;
          try {
            const value = localStorage.getItem(key);
            if (value === null) continue;
            const storage = prefix === sessionLogPrefix ? nativeSnapshots : nativePromptQueue;
            await storage.write(decodeURIComponent(key.slice(prefix.length)), value, true);
            verified.add(key);
          } catch (cause) {
            failed++;
            reason = String(cause);
          }
        }
        error = failed ? `${failed} 份旧会话数据迁移失败：${reason}` : undefined;
      } catch (cause) {
        error = String(cause);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return {
    migrate,
    category: {
      id: "storage.legacy",
      label: "迁移遗留数据",
      risk: "删除已核验的旧 WebView 数据副本。",
      saveFailure: { message: () => error ?? sessionTitleMigrationFailure(), retry: migrate },
      list() {
        const keys = Object.keys(localStorage).filter((key) => key.startsWith(sessionLogPrefix) ||
          key.startsWith(queuePrefix) || isSessionTitleKey(key) || managedProjectStorage()?.isManagedKey(key));
        const records = keys.flatMap((key) => {
          const value = localStorage.getItem(key);
          if (value === null) return [];
          return [{
            key, bytes: (key.length + value.length) * 2, revision: value,
            protected: !verified.has(key) && !migratedSessionTitle(key) && !managedProjectStorage()?.migrated(key),
            protectedReason: "迁移尚未核验或旧记录尚未确认 Agent 归属",
          }];
        });
        return [...records, ...imageSources.flatMap((source) => source.legacyEntries().map((entry) => ({
          ...entry, key: source.prefix + entry.key,
        })))];
      },
      remove({ key, revision }) {
        const source = imageSources.find(({ prefix }) => key.startsWith(prefix));
        if (source) return source.removeLegacy(key.slice(source.prefix.length), revision);
        if ((!verified.has(key) && !migratedSessionTitle(key) && !managedProjectStorage()?.migrated(key)) ||
          localStorage.getItem(key) !== revision) return false;
        localStorage.removeItem(key);
        verified.delete(key);
        return true;
      },
    },
  };
}
