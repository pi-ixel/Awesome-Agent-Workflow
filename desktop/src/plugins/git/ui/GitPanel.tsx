import type { GitChange, GitSnapshot } from "../../host/types.ts";
import { useProjectGit } from "./useProjectGit.ts";
import type { ProjectWorkspace } from "../../project/service.ts";
import type { GitReviewReveal } from "./reviewNavigation.ts";
import type { GitService } from "../service.ts";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  changeKey,
  createGitRevealCursor,
  reviewChanges,
  type GitRevealCursor,
} from "../review/review.ts";
import { createGitDiffCache } from "../diff/diffCache.ts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGlyph,
} from "../../../shared/ui/icons.tsx";
import { ColumnResizer } from "../../../shared/ui/controls/ColumnResizer.tsx";
import { reviewRailWidths } from "../config.ts";
import { GitReviewDiff } from "./GitReviewDiff.tsx";
import { RefreshButton } from "../../../shared/ui/controls/RefreshButton.tsx";
import { GitLineStats } from "./GitLineStats.tsx";
export { GitDiffView } from "./GitDiffView.tsx";

export function GitPanel({
  project,
  git,
  reveal,
  watchActivity,
  revealRequest,
}: {
  project: string;
  git: GitService;
  reveal?: GitRevealCursor;
  watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"];
  revealRequest?: GitReviewReveal;
}) {
  const [localReveal] = useState(() => createGitRevealCursor());
  const result = useProjectGit(project, git.query, watchActivity);
  return (
    <div className="flex h-full min-h-0 flex-col text-ui-base">
      {result.error && (
        <p role="alert" className="p-3 text-danger-ink">
          {result.error}
        </p>
      )}
      {result.watchError && (
        <p className="p-2 text-warn-ink">{result.watchError}</p>
      )}
      {result.data?.statsWarning && (
        <p role="status" className="p-2 text-xs text-warn-ink">
          {result.data.statsWarning}
        </p>
      )}
      {result.data ? (
        <GitReview
          project={project}
          git={git}
          revealCursor={reveal ?? localReveal}
          reveal={revealRequest}
          data={result.data}
          onRefresh={result.refresh}
        />
      ) : (
        <div className="p-3">
          <RefreshButton key={project} onRefresh={result.refresh} />
          {result.loading && !result.data && (
            <p className="py-2">正在读取 Git 状态…</p>
          )}
        </div>
      )}
    </div>
  );
}

function GitReview({
  project,
  data,
  git,
  revealCursor,
  reveal,
  onRefresh,
}: {
  project: string;
  data: GitSnapshot;
  git: GitService;
  revealCursor: GitRevealCursor;
  reveal?: GitReviewReveal;
  onRefresh: () => Promise<void>;
}) {
  const [seenReveal, setSeenReveal] = useState(reveal);
  const [groups, setGroups] = useState({
    changes: true,
    untracked: reveal?.source === "untracked",
  });
  // 每次审阅入口请求都会递增 revision 并展开对应组。该组的
  // 文件树按波次重挂载并全量展开。工作台注册持有游标，GitPanel 在
  // 点胶囊时才首次挂载，若只看「挂载后 reveal 是否变化」，首次点击会被
  // seenReveal 的初始化吞掉（点胶囊永远不展开树的根因）；游标跨挂载
  // 存续，切页签回来（revision 未变）则不会把整理好的树重新摊开。
  const [revealWave, setRevealWave] = useState(() =>
    reveal !== undefined && reveal.revision > revealCursor.read()
      ? reveal.revision
      : 0,
  );
  const [openedUntracked, setOpenedUntracked] = useState<Set<string>>(
    new Set(),
  );
  const treeRef = useRef<HTMLElement>(null);
  const railLayout = useRef<HTMLDivElement>(null);
  const pendingLocation = useRef<string | null>(null);
  if (seenReveal !== reveal) {
    setSeenReveal(reveal);
    if (reveal) {
      setGroups((old) => ({
        ...old,
        [reveal.source === "untracked" ? "untracked" : "changes"]: true,
      }));
      if (reveal.revision > revealCursor.read()) {
        setRevealWave(reveal.revision);
      }
    }
  }
  const revealedGroup = reveal
    ? reveal.source === "untracked"
      ? "untracked"
      : "changes"
    : null;
  useLayoutEffect(() => {
    if (reveal) {
      revealCursor.consume(reveal.revision);
      treeRef.current
        ?.querySelector(
          `[data-git-group="${reveal.source === "untracked" ? "untracked" : "changes"}"]`,
        )
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [reveal, revealCursor]);
  // diff 默认收起（模型反馈）：expandedKey 指向谁就展开谁，其余一律收起
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
    git,
    cache: createGitDiffCache((change) =>
      git.diff(project, change),
    ),
  }));
  let cache = cacheState.cache;
  if (cacheState.data !== data || cacheState.project !== project || cacheState.git !== git) {
    const keys = new Set(
      [...data.changes, ...(data.branchChanges ?? [])].map(changeKey),
    );
    const previous =
      cacheState.project === project && cacheState.git === git
        ? Object.fromEntries(
            Object.entries(cacheState.cache.getSnapshot()).filter(([key]) =>
              keys.has(key),
            ),
          )
        : {};
    cache = createGitDiffCache(
      (change) => git.diff(project, change),
      previous,
    );
    setCacheState({ data, project, git, cache });
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
      isOpen = expandedKey === key;
    const name = change.path.split("/").at(-1) ?? change.path;
    const directory = change.path.includes("/")
      ? change.path.slice(0, change.path.lastIndexOf("/"))
      : "";
    return (
      <div data-review-index={index}>
        <button
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "收起" : "展开"} ${change.path}`}
          data-hint={`${change.oldPath ? `${change.oldPath} → ` : ""}${change.path} · ${change.status}`}
          className={`sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-base px-3 text-left transition-colors hover:bg-surface-hover ${isOpen ? "bg-surface-hover" : ""}`}
          onClick={() => {
            setExpanded(isOpen ? null : key);
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
            <span className="ml-2 text-ink-subtlest">{directory}</span>
          </span>
          <GitLineStats changes={[change]} />
          <ChevronDownIcon
            className={`h-4 w-4 shrink-0 text-ink-soft transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        </button>
        {isOpen && (
          <div className="border-b border-line">
            {(!entry || (entry.loading && !entry.model)) && (
              <p className="p-3 text-ink-soft">正在读取差异…</p>
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
      <div
        ref={railLayout}
        className="flex min-h-0 flex-1"
        style={{ "--git-review-rail-w": `${git.reviewRailWidth}px` } as CSSProperties}
      >
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
        <ColumnResizer
          cssVarName="--git-review-rail-w"
          rootRef={railLayout}
          onCommitWidth={git.setReviewRailWidth}
          defaultWidthPx={reviewRailWidths.initial}
          minPx={reviewRailWidths.min}
          maxPx={reviewRailWidths.max}
          growDirection="start"
          label="调整差异视图与工作区更改栏"
        />
        <aside
          ref={treeRef}
          aria-label="Git 文件导航"
          className="shrink-0 overflow-auto border-l border-line bg-base p-2"
          style={{ width: "var(--git-review-rail-w, 256px)" }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-ink-faint">工作区更改</span>
            <div className="flex items-center gap-0.5">
              <RefreshButton key={project} onRefresh={onRefresh} />
            </div>
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
                  <span className="ml-auto">
                    <GitLineStats changes={all} />
                  </span>
                </button>
                {isOpen && (
                  <GitFileTree
                    key={`${group}-${group === revealedGroup ? revealWave : 0}`}
                    initiallyExpanded={
                      group === revealedGroup && revealWave > 0
                    }
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

function toggleFolder(
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  key: string,
): void {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setExpanded(next);
}

function GitFileTree({
  changes,
  selectedPath,
  onSelect,
  red,
  prefix = "",
  initiallyExpanded = false,
}: {
  changes: GitChange[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  red: boolean;
  prefix?: string;
  /** 挂载即全量展开（悬浮卡点击波次的重挂载；逐层下传）。 */
  initiallyExpanded?: boolean;
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
  // 单链目录合并（信息密度）：无直属文件且仅一个子目录的文件夹，与子
  // 目录合并为复合名（a/b/c）。循环到不再可合并。
  let compressing = true;
  while (compressing) {
    compressing = false;
    for (const [name, children] of [...folders]) {
      const childPrefix = `${prefix}${name}/`;
      const tails = children.map((p) => p.slice(childPrefix.length));
      // 全部子项仍是目录（无直属文件）且只有一条子链才可合并
      if (tails.every((t) => t.includes("/"))) {
        const segs = new Set(tails.map((t) => t.slice(0, t.indexOf("/"))));
        if (segs.size === 1) {
          folders.delete(name);
          folders.set(`${name}/${[...segs][0]}`, children);
          compressing = true;
          break;
        }
      }
    }
  }
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    initiallyExpanded
      ? new Set([...folders.keys()].map((name) => `${prefix}${name}`))
      : new Set(),
  );
  // 跳转波次的时序兜底：波次到达时数据可能还没来（空树消费不掉展开集），
  // 数据到达（folders.size 变化）后补一次全量展开；用户手动折叠后
  // waveApplied 已置位，后续数据刷新不再反复摊开。
  const [waveApplied, setWaveApplied] = useState(false);
  // 波次是 props 驱动的本组件状态迁移，同步调整可避免 effect 的级联渲染。
  if (initiallyExpanded && !waveApplied && folders.size > 0) {
    setWaveApplied(true);
    setExpanded(new Set([...folders.keys()].map((name) => `${prefix}${name}`)));
  }
  return (
    <div className="space-y-1">
      {[...folders].map(([name, children]) => {
        const isOpen = expanded.has(`${prefix}${name}`);
        return (
          <div key={name}>
            <button
              type="button"
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-raised"
              onClick={() =>
                toggleFolder(expanded, setExpanded, `${prefix}${name}`)
              }
            >
              <span
                aria-hidden={true}
                className="shrink-0 text-ink-faint transition-transform"
                style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
              >
                <ChevronRightIcon className="h-3 w-3" />
              </span>
              <FolderGlyph isExpanded={isOpen} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </button>
            {isOpen && (
              <div className="ml-3 border-l border-line pl-2">
                <GitFileTree
                  changes={changes.filter((change) =>
                    children.includes(change.path),
                  )}
                  selectedPath={selectedPath}
                  prefix={`${prefix}${name}/`}
                  red={red}
                  onSelect={onSelect}
                  initiallyExpanded={initiallyExpanded}
                />
              </div>
            )}
          </div>
        );
      })}
      {files.map((path) => (
        <button
          key={path}
          data-hint={path}
          aria-label={`定位 ${path}`}
          aria-current={selectedPath === path ? "true" : undefined}
          className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-raised ${selectedPath === path ? "bg-selected" : ""} ${red || changes.some((c) => c.path === path && c.source === "conflict") ? "text-danger-ink" : ""}`}
          onClick={() => onSelect(path)}
        >
          <span className="min-w-0 flex-1 truncate">
            {path.slice(prefix.length)}
          </span>
          <GitLineStats changes={changes.filter((c) => c.path === path)} />
        </button>
      ))}
    </div>
  );
}
