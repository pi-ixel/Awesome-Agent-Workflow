import {
  sessionAgentId,
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
import type { SessionRecords } from "./sessionMetadata.ts";

export interface CatalogOwner {
  readonly workspacePath: string;
  readonly agentKey: string;
}

/**
 * 会话列表回填（左栏树可见）：按活动时间排序，并列时沿用已有顺序。标题一律
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
  const catalogSessions =
    catalog.agentKey === runtime.agentKey
      ? (Object.entries(catalog.sessionsByPath).find(
          ([path]) => pathKey(path) === pathKey(runtime.workspacePath),
        )?.[1] ?? [])
      : [];
  const previousEntries = new Map(
    [...cachedSessions, ...catalogSessions].map((entry) => [entry.id, entry]),
  );
  const previousOrder = new Map<string, number>();
  for (const entry of [...catalogSessions, ...cachedSessions]) {
    if (!previousOrder.has(entry.id)) previousOrder.set(entry.id, previousOrder.size);
  }
  const cachedTitle = (id: string): string | undefined => {
    const entry = previousEntries.get(id);
    const title = agentSessionTitle(entry?.nativeTitle ?? entry?.title);
    return title === "会话" ? undefined : title;
  };
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
        cached ?? sessionTitleOf(store.items),
      // 排序语义对齐 ZCode：updatedAt = 会话最后活动时间（chrys 权威
      // 优先，本地缓存次之）。打开/切换会话**不**盖当前时刻——否则每次
      // 载入历史会话它都会跳到列表顶部。全新会话（无任何时间来源，首条
      // 消息转正 / forceNew 新建）兜底 now：置顶一次是合理的。
      updatedAt:
        listedSelf?.updatedAt ??
        (listedSelf || previousEntries.has(activeSessionId)
          ? previousEntries.get(activeSessionId)?.updatedAt ?? null
          : new Date().toISOString()),
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
      updatedAt: info.updatedAt ?? previousEntries.get(info.sessionId)?.updatedAt ?? null,
    });
  }
  // 新连接的索引可能不完整，缺席不代表删除；保留已知会话。
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
          : displayTitleOf(entry.id, fallback, runtime.agentKey, runtime.workspacePath),
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
    if (au === bu) return (previousOrder.get(a.id) ?? previousOrder.size) -
      (previousOrder.get(b.id) ?? previousOrder.size);
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
  hidden: (target: DeleteSessionTarget) => boolean = () => false,
  retainedSessions: (agent: string) => { project: string; sessionId: string }[] = () => [],
  localRecords: () => Iterable<SessionRecords["records"][number]> = () => [],
) {
  const store = createStore<SessionCatalogState>()(() => emptyCatalog);
  const catalogCache = new Map<string, SessionCatalogState>();
  const externalSessions = new Set<string>();
  const externalKey = (agent: string, path: string, id: string) =>
    JSON.stringify([sessionAgentId(agent) ?? agent, pathKey(path), id]);
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
        !hidden({ agentKey: agent, workspacePath: path, sessionId: entry.id }),
    );
  };

  function excludeSessions(sessions: readonly SessionTarget[]): void {
    if (signal.aborted) return;
    for (const session of sessions) {
      if (session.sessionId) externalSessions.add(externalKey(session.agentKey, session.workspacePath, session.sessionId));
    }
    refreshVisibility();
  }

  function refreshVisibility(): void {
    if (signal.aborted) return;
    const filter = (state: SessionCatalogState): SessionCatalogState => {
      let changed = false;
      const sessionsByPath = Object.fromEntries(
        Object.entries(state.sessionsByPath).map(
          ([path, entries]): [string, readonly SessionSummary[]] => {
            const visible = visibleEntries(state.agentKey ?? "", path, entries);
            if (
              visible.length === entries.length &&
              visible.every((entry, index) => entry === entries[index])
            )
              return [path, entries];
            changed = true;
            return [path, visible];
          },
        ),
      );
      return changed ? { ...state, sessionsByPath } : state;
    };
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
      const cached = catalogCache.get(agentKey);
      const byPath = { ...cached?.sessionsByPath };
      if (!cached) {
        const agentId = sessionAgentId(agentKey) ?? agentKey;
        const localByPath = new Map<string, SessionSummary[]>();
        for (const record of localRecords()) {
          if (record.agentId !== agentId) continue;
          const path = pathKey(record.project);
          const entries = localByPath.get(path) ?? [];
          const updatedAt = record.metadata.listing?.updatedAt ?? record.metadata.archive?.updatedAt ?? null;
          const nativeTitle = agentSessionTitle(record.metadata.listing?.title)
            ?? agentSessionTitle(record.metadata.archive?.title)
            ?? sessionListTitleOf(updatedAt);
          entries.push({ id: record.sessionId, title: record.title ?? nativeTitle, nativeTitle, updatedAt });
          localByPath.set(path, entries);
        }
        for (const [path, entries] of localByPath) {
          byPath[path] = entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        }
      }
      const paths = new Set(Object.keys(byPath).map(pathKey));
      for (const { project } of retainedSessions(agentKey)) {
        const path = pathKey(project);
        if (!paths.has(path)) byPath[path] = [];
      }
      for (const [path, entries] of Object.entries(byPath)) {
        byPath[path] = visibleEntries(agentKey, path, entries);
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
    workspacePath?: string,
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
            !workspacePath || pathKey(path) === pathKey(workspacePath) ? list.map((entry) => {
              if (entry.id !== sessionId) return entry;
              const nativeTitle = entry.nativeTitle ?? entry.title;
              return {
                ...entry,
                nativeTitle,
                title: displayTitleOf(sessionId, nativeTitle, agentKey, path),
              };
            }) : list,
          ]),
        ),
      };
      });
    };
    const save = setManualTitle(sessionId, title, agentKey, workspacePath);
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
    refreshVisibility,
    isExternal: (target: DeleteSessionTarget) =>
      externalSessions.has(externalKey(target.agentKey, target.workspacePath, target.sessionId)),
  };
}
