import { SESSION_LOG_ITEM_LIMIT } from "../conversation/sessionStore.ts";
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
    [agent, scope] = tuple;
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
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !match(key)) continue;
          const value = localStorage.getItem(key);
          if (value !== null) rows.push(entry(key, value));
        }
        return rows;
      },
      remove(item) {
        const current = localStorage.getItem(item.key);
        if (
          current === null ||
          current !== item.revision ||
          entry(item.key, current).protected
        )
          return false;
        localStorage.removeItem(item.key);
        return true;
      },
    };
  }
  const scoped = (prefix: string) => (key: string) =>
    conversationScope(decodeURIComponent(key.slice(prefix.length)));
  const logs = "aaw-desktop/session-log/";
  const queue = "aaw-desktop/prompt-queue.v1/";
  const draft = "aaw-desktop/draft/";
  const history = "aaw-desktop/prompt-history/";
  const annotation = "/document-annotations-v1";
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
            )
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
        const workspace = localStorage.getItem("aaw-desktop/workspace/v1");
        if (workspace) {
          const { pinnedSessions } = JSON.parse(workspace);
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
    category(
      "project.session-cache",
      "会话快照",
      "删除本地回放缓存。重新打开时将从 Agent 加载历史。",
      (key) => key.startsWith(logs),
      scoped(logs),
    ),
    category(
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
      "输入历史",
      "清理后，将无法从输入历史找回这些内容。",
      (key) => key.startsWith(history),
      draftScope,
    ),
  ];
}
