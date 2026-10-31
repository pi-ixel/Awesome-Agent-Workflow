/**
 * 文件树数据源（对齐 ZCode useWorkspaceFileTreeData.ts 的关键语义，数据
 * 边界换成 desktop panelService）：
 *
 * - 目录快照按 pathKey 缓存；展开目录懒加载，目录级请求序号防止旧快照
 *   晚返回覆盖新树；
 * - 根目录加载发现「唯一子项是普通目录」时静默预载（单链压扁的前置数据）；
 * - 失效刷新重读根 + 已展开/已加载目录（并发 2），再刷新 Git 状态；
 * - 展开记忆保留：折叠只移除本行（含 compact 链）的展开态，子孙状态与
 *   目录快照不删除（ZCode 行为，替代 desktop 旧版级联删除）；
 * - Git 状态：panel_git_status 的仓库相对路径换算成绝对路径入键；
 *   非 Git 仓库 available=false，读取失败同样回退不可用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { panelError, panelService } from "../../../core/panelService.ts";
import { pathKey } from "../../../core/panelPaths.ts";
import { FILE_TREE_REFRESH_CONCURRENCY } from "./constants.ts";
import { readDirectory } from "./readDirectory.ts";
import {
  buildFileTreeGitState,
  flattenFileTreeRows,
  getChildDepth,
  type FileTreeDeletedFile,
  type FileTreeGitStatus,
  type FileTreeNode,
  type FileTreeRow,
} from "./model.ts";

type LoadResult = "loaded" | "stale" | "failed";

function replaceKey(
  current: ReadonlySet<string>,
  key: string,
  present: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

export function useFileTreeData({
  root,
  gitEnabled,
}: {
  root: string;
  /** 项目外临时目录不拉 Git 状态（对齐 enableWorkspaceFeatures=false）。 */
  gitEnabled: boolean;
}): {
  rows: FileTreeRow[];
  rootKey: string;
  rootLoading: boolean;
  rootLoaded: boolean;
  rootError: string | null;
  rootTruncated: boolean;
  expandedKeys: ReadonlySet<string>;
  setExpandedKeys: (
    updater: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  gitStatusByPath: ReadonlyMap<string, FileTreeGitStatus>;
  gitStatusAvailable: boolean;
  refreshing: boolean;
  loadDirectory: (
    path: string,
    childDepth: number,
    options?: { force?: boolean; silent?: boolean },
  ) => Promise<LoadResult>;
  refreshAll: () => Promise<void>;
} {
  const rootKey = pathKey(root);
  const [childrenByKey, setChildrenByKey] = useState<
    ReadonlyMap<string, FileTreeNode[]>
  >(new Map());
  const [expandedKeys, setExpandedKeysState] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [loadedKeys, setLoadedKeys] = useState<ReadonlySet<string>>(new Set());
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<string>>(new Set());
  const [errorByKey, setErrorByKey] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [gitStatusByPath, setGitStatusByPath] = useState<
    ReadonlyMap<string, FileTreeGitStatus>
  >(new Map());
  const [gitStatusAvailable, setGitStatusAvailable] = useState(false);
  const [deletedFiles, setDeletedFiles] = useState<readonly FileTreeDeletedFile[]>([]);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 与 state 同步维护的镜像 ref：请求去重需要同步可读的最新集合。
  const loadingRef = useRef<ReadonlySet<string>>(new Set());
  const loadedRef = useRef<ReadonlySet<string>>(new Set());
  /** key → 展示路径（原始大小写/分隔符）。expandedKeys/loadedRef 存的是
   *  pathKey（Windows 折叠小写），重读必须用展示路径，否则会把 key 当路径
   *  去读——Windows 靠不区分大小写的 canonicalize 侥幸命中，大小写敏感的
   *  环境（与严格 mock）会读到空目录，把已加载子树清空。 */
  const displayPathsRef = useRef<Map<string, string>>(new Map());
  const generationRef = useRef(0);
  const directoryVersionRef = useRef<Map<string, number>>(new Map());
  const gitVersionRef = useRef(0);
  const refreshBatchRef = useRef(0);
  const refreshingRef = useRef(false);

  const setKeyLoading = useCallback((key: string, present: boolean) => {
    loadingRef.current = replaceKey(loadingRef.current, key, present);
    setLoadingKeys(loadingRef.current);
  }, []);

  const setKeyLoaded = useCallback((key: string, present: boolean) => {
    loadedRef.current = replaceKey(loadedRef.current, key, present);
    setLoadedKeys(loadedRef.current);
  }, []);

  const setExpandedKeys = useCallback(
    (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
      setExpandedKeysState((current) => updater(current));
    },
    [],
  );

  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      childDepth: number,
      options?: { force?: boolean; silent?: boolean },
    ): Promise<LoadResult> => {
      const expectedGeneration = generationRef.current;
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const key = pathKey(directoryPath);
      if (!force && (loadingRef.current.has(key) || loadedRef.current.has(key))) {
        return "loaded";
      }
      // 目录级请求序号：手动刷新与 watcher 刷新可能并发读同一目录，
      // 旧快照晚返回不能覆盖新树。
      const version = (directoryVersionRef.current.get(key) ?? 0) + 1;
      directoryVersionRef.current.set(key, version);
      displayPathsRef.current.set(key, directoryPath);
      const isCurrent = () =>
        generationRef.current === expectedGeneration &&
        directoryVersionRef.current.get(key) === version;
      if (!silent) setKeyLoading(key, true);
      setErrorByKey((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      try {
        const data = await readDirectory(directoryPath);
        if (!isCurrent()) return "stale";
        setChildrenByKey((current) => {
          const next = new Map(current);
          next.set(
            key,
            data.entries.map((entry) => ({
              path: entry.path,
              key: pathKey(entry.path),
              name: entry.name,
              directory: entry.directory,
              symlink: entry.symlink,
              depth: childDepth,
            })),
          );
          return next;
        });
        setKeyLoaded(key, true);
        if (key === rootKey) setRootTruncated(data.truncated);
        // 唯一子项是普通目录 → 静默预载，单链压扁才有数据可用。
        const only = data.entries[0];
        if (data.entries.length === 1 && only !== undefined && only.directory && !only.symlink) {
          void loadDirectory(only.path, childDepth + 1, {
            silent: true,
          });
        }
        return "loaded";
      } catch (error) {
        if (!isCurrent()) return "stale";
        setErrorByKey((current) => {
          const next = new Map(current);
          next.set(key, panelError(error));
          return next;
        });
        return "failed";
      } finally {
        if (isCurrent()) setKeyLoading(key, false);
      }
    },
    [rootKey, setKeyLoaded, setKeyLoading],
  );

  const loadGitStatus = useCallback(
    async (expectedGeneration?: number) => {
      const generation = expectedGeneration ?? generationRef.current;
      if (!gitEnabled) {
        setGitStatusAvailable(false);
        setGitStatusByPath(new Map());
        setDeletedFiles([]);
        return;
      }
      const version = ++gitVersionRef.current;
      try {
        const snapshot = await panelService.gitStatus(root);
        if (
          gitVersionRef.current !== version ||
          generationRef.current !== generation
        ) {
          return;
        }
        if (!snapshot.repoRoot) {
          setGitStatusAvailable(false);
          setGitStatusByPath(new Map());
          setDeletedFiles([]);
          return;
        }
        const state = buildFileTreeGitState(snapshot.changes, snapshot.repoRoot);
        setGitStatusAvailable(true);
        setGitStatusByPath(state.statusByPath);
        setDeletedFiles(state.deletedFiles);
      } catch {
        if (
          gitVersionRef.current !== version ||
          generationRef.current !== generation
        ) {
          return;
        }
        // Git 状态读取异常时不保留旧的变更过滤入口。
        setGitStatusAvailable(false);
        setGitStatusByPath(new Map());
        setDeletedFiles([]);
      }
    },
    [gitEnabled, root],
  );

  /** 重读根 + 已展开/已加载目录（并发 2），完成后刷新 Git 状态。 */
  const refreshAll = useCallback(async () => {
    if (refreshingRef.current) return;
    const generation = generationRef.current;
    const batch = ++refreshBatchRef.current;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const paths = new Set<string>([
        root,
        ...[...expandedKeys, ...loadedRef.current].map(
          (key) => displayPathsRef.current.get(key) ?? key,
        ),
      ]);
      const queue = [...paths];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (
          cursor < queue.length &&
          generationRef.current === generation &&
          refreshBatchRef.current === batch
        ) {
          const path = queue[cursor];
          cursor += 1;
          if (path !== undefined) {
            await loadDirectory(path, getChildDepth(rootKey, pathKey(path)), {
              force: true,
              silent: true,
            });
          }
        }
      };
      await Promise.allSettled(
        Array.from(
          { length: Math.min(FILE_TREE_REFRESH_CONCURRENCY, queue.length) },
          () => worker(),
        ),
      );
      if (
        generationRef.current === generation &&
        refreshBatchRef.current === batch
      ) {
        await loadGitStatus(generation);
      }
    } finally {
      refreshingRef.current = false;
      if (
        generationRef.current === generation &&
        refreshBatchRef.current === batch
      ) {
        setRefreshing(false);
      }
    }
  }, [expandedKeys, loadDirectory, loadGitStatus, root, rootKey]);

  // 换根：整体重置并重载（组件通常已按 root 外部重挂，这里兜底 prop 换根）。
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    directoryVersionRef.current = new Map();
    gitVersionRef.current += 1;
    refreshBatchRef.current += 1;
    refreshingRef.current = false;
    loadingRef.current = new Set();
    loadedRef.current = new Set();
    displayPathsRef.current = new Map();
    setChildrenByKey(new Map());
    setExpandedKeysState(new Set());
    setLoadingKeys(new Set());
    setLoadedKeys(new Set());
    setErrorByKey(new Map());
    setGitStatusByPath(new Map());
    setGitStatusAvailable(false);
    setDeletedFiles([]);
    setRootTruncated(false);
    setRefreshing(false);
    void loadDirectory(root, 0, { force: true });
    void loadGitStatus(generation);
    return () => {
      // 卸载/换根后作废迟到请求与排队刷新。
      generationRef.current += 1;
      gitVersionRef.current += 1;
      refreshBatchRef.current += 1;
      refreshingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey]);

  const rows = useMemo(
    () =>
      flattenFileTreeRows({
        rootKey,
        childrenByKey,
        expandedKeys,
        loadedKeys,
        loadingKeys,
        errorByKey,
        deletedFiles,
      }),
    [
      childrenByKey,
      deletedFiles,
      errorByKey,
      expandedKeys,
      loadedKeys,
      loadingKeys,
      rootKey,
    ],
  );

  return {
    rows,
    rootKey,
    rootLoading: loadingKeys.has(rootKey),
    rootLoaded: loadedKeys.has(rootKey),
    rootError: errorByKey.get(rootKey) ?? null,
    rootTruncated,
    expandedKeys,
    setExpandedKeys,
    gitStatusByPath,
    gitStatusAvailable,
    refreshing,
    loadDirectory,
    refreshAll,
  };
}

export function getWatchPaths(
  root: string,
  expandedKeys: ReadonlySet<string>,
): { path: string; recursive: boolean }[] {
  return [
    { path: root, recursive: false },
    ...[...expandedKeys]
      .filter((key) => key !== pathKey(root))
      .map((path) => ({ path, recursive: false })),
  ];
}
