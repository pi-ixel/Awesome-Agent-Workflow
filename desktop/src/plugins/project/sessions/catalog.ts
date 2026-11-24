import {
  sameSessionAgent,
  type DeleteSessionTarget,
} from "./sessionDeletion.ts";
import { createStore } from "zustand";
import type {
  SessionCatalogState,
  SessionListStatus,
} from "./indexTypes.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { agentSessionTitle, setManualTitle, displayTitleOf } from "./sessionTitles.ts";
import {
  sessionTitleOf,
  type SessionStoreState,
  type SessionSummary,
} from "../conversation/sessionStore.ts";
import type { SessionInfo } from "../../../contracts/acp/protocol.ts";
import type { SessionTarget } from "./types.ts";

export interface CatalogOwner {
  readonly workspacePath: string;
  readonly agentKey: string;
}

/**
 * 会话列表回填（左栏树可见）：当前会话置顶，其余历史会话随后；标题一律
 * 不含 UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，断开后树仍
 * 能显示该项目的历史会话子节点。恢复的历史会话优先用 session/list 的
 * 权威标题；新会话从消息流首条用户消息推导。
 */
export function sessionListEntries(
  store: Pick<SessionStoreState, "sessionsByPath" | "items">,
  listed: readonly SessionInfo[],
  activeSessionId: string | null,
  runtime: CatalogOwner,
  retainedEntries: Iterable<SessionSummary>,
  catalog: SessionCatalogState,
): SessionSummary[] {
  const cachedSessions =
    Object.entries(store.sessionsByPath).find(
      ([path]) => pathKey(path) === pathKey(runtime.workspacePath),
    )?.[1] ?? [];
  const cachedTitle = (id: string): string | undefined => {
    const entry = cachedSessions.find((cached) => cached.id === id);
    return agentSessionTitle(entry?.nativeTitle ?? entry?.title);
  };
  const cachedUpdatedAt = (id: string): string | null | undefined =>
    cachedSessions.find((entry) => entry.id === id)?.updatedAt;
  const entries: SessionSummary[] = [];
  if (activeSessionId !== null) {
    const listedSelf = listed.find(
      (info) => info.sessionId === activeSessionId,
    );
    const cached = cachedTitle(activeSessionId);
    entries.push({
      id: activeSessionId,
      title:
        agentSessionTitle(listedSelf?.title) ??
        (cached && cached !== "会话" ? cached : sessionTitleOf(store.items)),
      // 排序语义对齐 ZCode：updatedAt = 会话最后活动时间（chrys 权威
      // 优先，本地缓存次之）。打开/切换会话**不**盖当前时刻——否则每次
      // 载入历史会话它都会跳到列表顶部。全新会话（无任何时间来源，首条
      // 消息转正 / forceNew 新建）兜底 now：置顶一次是合理的。
      updatedAt:
        listedSelf?.updatedAt ??
        cachedUpdatedAt(activeSessionId) ??
        new Date().toISOString(),
    });
  }
  for (const info of listed) {
    if (info.sessionId === activeSessionId) {
      continue;
    }
    entries.push({
      id: info.sessionId,
      title:
        agentSessionTitle(info.title) ??
        cachedTitle(info.sessionId) ??
        sessionListTitleOf(info.updatedAt),
      updatedAt: info.updatedAt ?? null,
    });
  }
  // 新连接的索引可能不完整，缺席不代表删除；保留已知会话。
  const catalogSessions =
    catalog.agentKey === runtime.agentKey
      ? (Object.entries(catalog.sessionsByPath).find(
          ([path]) => pathKey(path) === pathKey(runtime.workspacePath),
        )?.[1] ?? [])
      : [];
  const retain = (entry: SessionSummary) => {
    if (entries.some((item) => item.id === entry.id)) return;
    const nativeTitle = entry.nativeTitle ?? entry.title;
    if (!nativeTitle.trim() || agentSessionTitle(nativeTitle)) {
      entries.push(entry);
      return;
    }
    const fallback = sessionListTitleOf(entry.updatedAt);
    entries.push({
      ...entry,
      nativeTitle: fallback,
      title:
        entry.title !== nativeTitle
          ? entry.title
          : displayTitleOf(entry.id, fallback, runtime.agentKey),
    });
  };
  for (const entry of [...catalogSessions, ...cachedSessions]) retain(entry);
  // 索引可能滞后：本次进程的 session/list 不能隐藏仍在后台执行的会话。
  for (const entry of retainedEntries) retain(entry);
  // 展示序 = 最后活动时间倒序（ZCode 同语义）：当前会话不再人为置顶——
  // 打开历史会话时它回到自己的活动位置，列表不跳。
  entries.sort((a, b) => {
    const au = a.updatedAt ?? "";
    const bu = b.updatedAt ?? "";
    if (au === bu) return 0;
    if (au === "") return 1;
    if (bu === "") return -1;
    return au < bu ? 1 : -1;
  });
  return entries;
}

/** ISO 时间 → 列表标题用 HH:MM（本地时区）。 */
function hhmmOf(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return "";
  }
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 历史会话的兜底标题（agent 未提供 title 时不露出 UUID）。 */
function sessionListTitleOf(updatedAt?: string | null): string {
  const hhmm = typeof updatedAt === "string" ? hhmmOf(updatedAt) : "";
  return hhmm === "" ? "会话" : `会话 · ${hhmm}`;
}

export const emptyCatalog: SessionCatalogState = {
  agentKey: null,
  sessionsByPath: {},
  statusByPath: {},
};

/** Directory and per-Agent cached indexes are owned by one Project Fiber. */
export function createSessionCatalog(
  signal: AbortSignal,
  deleted: (target: DeleteSessionTarget) => boolean = () => false,
  retainedSessions: (agent: string) => { project: string; sessionId: string }[] = () => [],
) {
  const store = createStore<SessionCatalogState>()(() => emptyCatalog);
  const catalogCache = new Map<string, SessionCatalogState>();
  const externalSessions = new Set<string>();
  const externalKey = (agent: string, path: string, id: string) =>
    JSON.stringify([agent, pathKey(path), id]);
  const visibleEntries = (
    agent: string,
    path: string,
    entries: readonly SessionSummary[],
  ) => {
    const ids = new Set(entries.map((entry) => entry.id));
    const missing = retainedSessions(agent)
      .filter((owner) => pathKey(owner.project) === pathKey(path) && !ids.has(owner.sessionId))
      .map(({ sessionId }) => ({ id: sessionId, title: "会话", updatedAt: null }));
    return [...entries, ...missing].filter(
      (entry) =>
        !externalSessions.has(externalKey(agent, path, entry.id)) &&
        !deleted({ agentKey: agent, workspacePath: path, sessionId: entry.id }),
    );
  };

  function excludeSessions(sessions: readonly SessionTarget[]): void {
    if (signal.aborted) return;
    for (const session of sessions) {
      if (session.sessionId) externalSessions.add(externalKey(session.agentKey, session.workspacePath, session.sessionId));
    }
    const filter = (state: SessionCatalogState): SessionCatalogState => ({
      ...state,
      sessionsByPath: Object.fromEntries(Object.entries(state.sessionsByPath).map(([path, entries]) =>
        [path, visibleEntries(state.agentKey ?? "", path, entries)])),
    });
    for (const [agent, state] of catalogCache) catalogCache.set(agent, filter(state));
    store.setState(filter(store.getState()));
  }

  function selectCatalog(
    agentKey: string,
    invalidatePreviousPreparation: () => void,
  ): string {
    if (signal.aborted) return agentKey;
    const current = store.getState();
    if (current.agentKey !== agentKey) {
      if (current.agentKey) catalogCache.set(current.agentKey, current);
      invalidatePreviousPreparation();
      const byPath = { ...catalogCache.get(agentKey)?.sessionsByPath };
      for (const path of new Set(retainedSessions(agentKey).map((owner) => owner.project))) {
        byPath[path] = visibleEntries(agentKey, path, byPath[path] ?? []);
      }
      store.setState({
        agentKey,
        sessionsByPath: byPath,
        statusByPath: {},
      });
    }
    return agentKey;
  }

  function writeCatalogStatus(
    selectedAgentKey: string,
    path: string,
    agentKey: string,
    status: SessionListStatus,
  ): void {
    if (
      signal.aborted ||
      agentKey !== selectedAgentKey ||
      store.getState().agentKey !== agentKey
    )
      return;
    store.setState((state) => ({
      statusByPath: { ...state.statusByPath, [pathKey(path)]: status },
    }));
  }

  /** Sidebar actions belong to its catalog owner, which may differ from the focused session. */
  function renameCatalogEntry(
    agentKey: string,
    sessionId: string,
    title: string,
    updateOpenViews: () => void,
  ): void | Promise<void> {
    if (signal.aborted) return;
    const publish = () => {
      if (signal.aborted) return;
      updateOpenViews();
      store.setState((state) => {
      if (state.agentKey !== agentKey) return state;
      return {
        sessionsByPath: Object.fromEntries(
          Object.entries(state.sessionsByPath).map(([path, list]) => [
            path,
            list.map((entry) => {
              if (entry.id !== sessionId) return entry;
              const nativeTitle = entry.nativeTitle ?? entry.title;
              return {
                ...entry,
                nativeTitle,
                title: displayTitleOf(sessionId, nativeTitle, agentKey),
              };
            }),
          ]),
        ),
      };
      });
    };
    const save = setManualTitle(sessionId, title, agentKey);
    if (save) return save.then(publish);
    publish();
  }

  function updateCatalog(
    selectedAgentKey: string,
    runtime: CatalogOwner,
    entries: readonly SessionSummary[],
  ): void {
    if (
      signal.aborted ||
      runtime.agentKey !== selectedAgentKey ||
      store.getState().agentKey !== runtime.agentKey
    )
      return;
    const visible = visibleEntries(runtime.agentKey, runtime.workspacePath, entries);
    const previous = store.getState().sessionsByPath[runtime.workspacePath];
    if (previous?.length === visible.length && previous.every((entry, index) => entry === visible[index])) return;
    store.setState((state) => {
      const byPath = { ...state.sessionsByPath };
      for (const path of Object.keys(byPath))
        if (pathKey(path) === pathKey(runtime.workspacePath))
          delete byPath[path];
      byPath[runtime.workspacePath] = visible;
      return { sessionsByPath: byPath };
    });
  }

  function resetCatalog(): void {
    catalogCache.clear();
    store.setState(emptyCatalog, true);
  }

  return {
    store,
    selectCatalog,
    writeCatalogStatus,
    renameCatalogEntry,
    updateCatalog,
    resetCatalog,
    excludeSessions,
    isExternal: (target: DeleteSessionTarget) =>
      [...externalSessions].some((key) => {
        const [agent, path, id] = JSON.parse(key) as [string, string, string];
        return (
          path === pathKey(target.workspacePath) &&
          id === target.sessionId &&
          sameSessionAgent(agent, target.agentKey)
        );
      }),
  };
}
