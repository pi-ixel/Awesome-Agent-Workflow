import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  panelService,
  type GitChange,
  type GitSnapshot,
} from "../../core/panelService.ts";
import { changeKey, reviewChanges } from "../../core/gitReview.ts";
import { createGitDiffCache } from "../../core/gitDiffCache.ts";
import { useProjectGit } from "./useProjectGit.ts";
import { GitReviewDiff } from "./GitReviewDiff.tsx";
import { useRightPanelStore } from "../../stores/rightPanelStore.ts";
import { pathKey } from "../../core/panelPaths.ts";
export { GitDiffView } from "./GitDiffView.tsx";

export function GitPanel({ project }: { project: string }) {
  const result = useProjectGit(project);
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      {result.error && (
        <p role="alert" className="p-3 text-danger-ink">
          {result.error}
        </p>
      )}
      {result.watchError && (
        <p className="p-2 text-warn-ink">{result.watchError}</p>
      )}
      {result.data ? (
        <GitReview
          project={project}
          data={result.data}
          onRefresh={result.refresh}
        />
      ) : (
        <div className="p-3">
          <button
            className="rounded border border-line px-2 py-1"
            onClick={result.refresh}
          >
            刷新
          </button>
          {result.loading && <p className="py-2">正在读取 Git 状态…</p>}
        </div>
      )}
    </div>
  );
}

function GitReview({
  project,
  data,
  onRefresh,
}: {
  project: string;
  data: GitSnapshot;
  onRefresh: () => void;
}) {
  const reveal = useRightPanelStore(
    (state) => state.projects[pathKey(project)]?.gitReveal,
  );
  const [seenReveal, setSeenReveal] = useState(reveal);
  const [groups, setGroups] = useState({
    changes: true,
    untracked: reveal?.source === "untracked",
  });
  const [openedUntracked, setOpenedUntracked] = useState<Set<string>>(
    new Set(),
  );
  const treeRef = useRef<HTMLElement>(null);
  const pendingLocation = useRef<string | null>(null);
  if (seenReveal !== reveal) {
    setSeenReveal(reveal);
    if (reveal) {
      setGroups((old) => ({
        ...old,
        [reveal.source === "untracked" ? "untracked" : "changes"]: true,
      }));
    }
  }
  useLayoutEffect(() => {
    if (reveal)
      treeRef.current
        ?.querySelector(
          `[data-git-group="${reveal.source === "untracked" ? "untracked" : "changes"}"]`,
        )
        ?.scrollIntoView?.({ block: "nearest" });
  }, [reveal]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [, setNavigation] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tracked = useMemo(() => reviewChanges(data, "changes"), [data]);
  const untracked = useMemo(() => reviewChanges(data, "untracked"), [data]);
  // 目录折叠只影响导航；正文保留当前阅读位置，未跟踪文件点击后才加入。
  const changes = useMemo(
    () => [
      ...tracked,
      ...untracked.filter((change) => openedUntracked.has(changeKey(change))),
    ],
    [tracked, untracked, openedUntracked],
  );
  const [cacheState, setCacheState] = useState(() => ({
    data,
    project,
    cache: createGitDiffCache((change) =>
      panelService.gitDiff(project, change),
    ),
  }));
  let cache = cacheState.cache;
  if (cacheState.data !== data || cacheState.project !== project) {
    const keys = new Set(
      [...data.changes, ...(data.branchChanges ?? [])].map(changeKey),
    );
    const previous =
      cacheState.project === project
        ? Object.fromEntries(
            Object.entries(cacheState.cache.getSnapshot()).filter(([key]) =>
              keys.has(key),
            ),
          )
        : {};
    cache = createGitDiffCache(
      (change) => panelService.gitDiff(project, change),
      previous,
    );
    setCacheState({ data, project, cache });
  }
  const entries = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => cache.retain(), [cache]);
  useEffect(() => {
    cache.request(changes);
  }, [cache, changes]);
  const expandedKey = expanded;
  // TanStack Virtual 自行维护测量状态，此组件不依赖 React Compiler 自动记忆化。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: changes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 14,
    getItemKey: (index) => (changes[index] ? changeKey(changes[index]) : index),
  });
  const virtual = changes.length > 100;
  useLayoutEffect(() => {
    const key = pendingLocation.current;
    if (!key) return;
    const index = changes.findIndex((change) => changeKey(change) === key);
    if (index < 0) return;
    if (virtual) virtualizer.scrollToIndex(index, { align: "start" });
    else
      scrollRef.current
        ?.querySelector(`[data-review-index="${index}"]`)
        ?.scrollIntoView?.({ block: "start" });
    pendingLocation.current = null;
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, expandedKey]);
  const renderChange = (index: number) => {
    const change = changes[index];
    if (!change) return null;
    const key = changeKey(change),
      entry = entries[key],
      isOpen = expandedKey === key || !collapsed.has(key);
    const name = change.path.split("/").at(-1) ?? change.path;
    const directory = change.path.includes("/")
      ? change.path.slice(0, change.path.lastIndexOf("/"))
      : "";
    return (
      <div data-review-index={index}>
        <button
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "收起" : "展开"} ${change.path}`}
          title={`${change.oldPath ? `${change.oldPath} → ` : ""}${change.path} · ${change.status}`}
          className={`sticky top-0 z-10 flex h-9 w-full items-center gap-2 border-b border-line bg-surface px-3 text-left hover:bg-raised ${isOpen ? "font-medium" : ""}`}
          onClick={() => {
            setExpanded(isOpen ? null : key);
            setCollapsed((old) => {
              const next = new Set(old);
              if (isOpen) next.add(key);
              else next.delete(key);
              return next;
            });
          }}
        >
          <span className="min-w-0 flex-1 truncate">
            <span
              className={
                change.source === "untracked" || change.source === "conflict"
                  ? "text-danger-ink"
                  : ""
              }
            >
              {name}
              {change.source === "conflict" ? " · 冲突" : ""}
            </span>
            <span className="ml-2 text-ink-faint">{directory}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap">
            <span className="text-ok-ink">+{change.added ?? 0}</span>
            <span className="ml-2 text-danger-ink">−{change.removed ?? 0}</span>
          </span>
          <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
        </button>
        {isOpen && (
          <div className="border-b border-line">
            {(!entry || (entry.loading && !entry.model)) && (
              <p className="p-3 text-ink-faint">正在读取差异…</p>
            )}
            {entry?.error && (
              <p role="alert" className="p-3 text-danger-ink">
                {entry.model
                  ? `刷新失败，暂时显示上次内容：${entry.error}`
                  : entry.error}
              </p>
            )}
            {entry?.data?.notice && (
              <p className="p-3 text-warn-ink">{entry.data.notice}</p>
            )}
            {entry?.model && <GitReviewDiff key={key} model={entry.model} />}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          aria-label="Git 变更文件列表"
        >
          {!data.repoRoot ? (
            <p className="p-4 text-ink-faint">此项目不是 Git 仓库</p>
          ) : changes.length === 0 ? (
            <p className="p-4 text-ink-faint">
              暂无已打开的差异；可从右侧选择文件
            </p>
          ) : virtual ? (
            <div
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 w-full"
                  style={{ top: row.start }}
                >
                  {renderChange(row.index)}
                </div>
              ))}
            </div>
          ) : (
            changes.map((change, index) => (
              <div key={changeKey(change)}>{renderChange(index)}</div>
            ))
          )}
        </div>
        <aside
          ref={treeRef}
          aria-label="Git 文件导航"
          className="w-64 max-w-[40%] shrink-0 overflow-auto border-l border-line p-2"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-ink-faint">工作区更改</span>
            <button
              className="rounded border border-line px-2 py-1"
              onClick={onRefresh}
            >
              刷新
            </button>
          </div>
          {(["changes", "untracked"] as const).map((group) => {
            const all = group === "changes" ? tracked : untracked;
            const isOpen = groups[group];
            const label = group === "changes" ? "Changes" : "Unversioned Files";
            return (
              <section key={group} data-git-group={group} className="mb-3">
                <button
                  aria-label={label}
                  aria-expanded={isOpen}
                  className={`flex w-full flex-wrap items-center gap-1 py-2 text-left ${group === "untracked" ? "text-danger-ink" : ""}`}
                  onClick={() =>
                    setGroups((old) => ({ ...old, [group]: !old[group] }))
                  }
                >
                  <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                  <span>{label}</span>
                  <span>
                    ({new Set(all.map((change) => change.path)).size})
                  </span>
                  <span className="ml-auto text-ok-ink">
                    +{all.reduce((n, c) => n + (c.added ?? 0), 0)}
                  </span>
                  <span className="text-danger-ink">
                    −{all.reduce((n, c) => n + (c.removed ?? 0), 0)}
                  </span>
                </button>
                {isOpen && (
                  <GitFileTree
                    changes={all}
                    selectedPath={
                      changes.find(
                        (change) => changeKey(change) === expandedKey,
                      )?.path
                    }
                    red={group === "untracked"}
                    onSelect={(path) => {
                      const change = all.find((item) => item.path === path);
                      if (!change) return;
                      const key = changeKey(change);
                      if (group === "untracked")
                        setOpenedUntracked((old) => new Set([...old, key]));
                      setExpanded(key);
                      setCollapsed((old) => {
                        const next = new Set(old);
                        next.delete(key);
                        return next;
                      });
                      pendingLocation.current = key;
                      setNavigation((old) => old + 1);
                    }}
                  />
                )}
              </section>
            );
          })}
        </aside>
      </div>
    </div>
  );
}

function GitFileTree({
  changes,
  selectedPath,
  onSelect,
  red,
  prefix = "",
}: {
  changes: GitChange[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  red: boolean;
  prefix?: string;
}) {
  const folders = new Map<string, string[]>();
  const files: string[] = [];
  for (const path of new Set(changes.map((change) => change.path))) {
    const tail = path.slice(prefix.length),
      slash = tail.indexOf("/");
    if (slash < 0) files.push(path);
    else {
      const name = tail.slice(0, slash);
      folders.set(name, [...(folders.get(name) ?? []), path]);
    }
  }
  return (
    <div className="space-y-1">
      {[...folders].map(([name, children]) => (
        <details key={name} open>
          <summary className="cursor-pointer truncate py-1">{name}</summary>
          <div className="ml-3 border-l border-line pl-2">
            <GitFileTree
              changes={changes.filter((change) =>
                children.includes(change.path),
              )}
              selectedPath={selectedPath}
              prefix={`${prefix}${name}/`}
              red={red}
              onSelect={onSelect}
            />
          </div>
        </details>
      ))}
      {files.map((path) => (
        <button
          key={path}
          title={path}
          aria-label={`定位 ${path}`}
          aria-current={selectedPath === path ? "true" : undefined}
          className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-raised ${selectedPath === path ? "bg-info-bg" : ""} ${red || changes.some((c) => c.path === path && c.source === "conflict") ? "text-danger-ink" : ""}`}
          onClick={() => onSelect(path)}
        >
          <span className="min-w-0 flex-1 truncate">
            {path.slice(prefix.length)}
          </span>
          <span className="shrink-0 text-ok-ink">
            +
            {changes
              .filter((c) => c.path === path)
              .reduce((n, c) => n + (c.added ?? 0), 0)}
          </span>
          <span className="shrink-0 text-danger-ink">
            −
            {changes
              .filter((c) => c.path === path)
              .reduce((n, c) => n + (c.removed ?? 0), 0)}
          </span>
        </button>
      ))}
    </div>
  );
}
