/**
 * 右栏「文件」分段主树（ZCode WorkspaceFileTree + FileManagerPane 的 desktop 移植）：
 *
 * - 布局（ZCode FileManagerPane 逻辑，图1/2 形态）：头部行常驻（⇄ 左置承载
 *   目录显隐；未选文件显「文件」标题，选中文件时 FilePreview 经 headerPortalTo
 *   把面包屑内片段 portal 进来）→ 树列（搜索框 → 标题行 → 虚拟树）|
 *   可拖分割条 | 预览列；树列宽度比例 + 显隐按根路径持久化
 *   （ZCode useDefaultLayout 等价）；
 * - 滚动容器：不在底部时 32px 渐隐 mask；可滚动且无搜索时启用吸顶目录
 *   （列表叠加随 scrollTop 平移的顶部 mask，offset 由原生 scroll 回调写
 *   CSS 变量同步，不走 React 状态避免拖滚动条落后一帧）；
 * - 虚拟化：行高 28px、overscan 12；行 = role=treeitem，Enter/ArrowRight/
 *   ArrowLeft 键盘漫游，单击执行主动作（双击 event.detail>1 只选中）；
 * - 搜索：非空查询切到全库平铺索引（行 depth=0、名字为相对路径），点目录
 *   清空查询并逐级展开回树态；「仅变更」过滤有状态行 + 有后代变更目录；
 * - reveal：右栏 store 里最近的文件页签在树内逐级展开并滚动定位。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  CopyIcon,
  EllipsisIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshIcon,
  SearchIcon,
  XIcon,
} from "../icons.tsx";
import { ContextMenu } from "../ContextMenu.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { insidePath, normalizePath, pathKey } from "../../core/panelPaths.ts";
import { useRightPanelStore } from "../../stores/rightPanelStore.ts";
import { useToastStore } from "../../stores/toastStore.ts";
import { useAgentRevision } from "./useAgentRevision.ts";
import { usePanelWatch } from "./usePanelWatch.ts";
import {
  FileTreeList,
} from "./file-tree/FileTreeList.tsx";
import {
  FILE_TREE_MASK_OFFSET_PROPERTY,
  FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
} from "./file-tree/constants.ts";
import { FileTreeStickyFolders } from "./file-tree/FileTreeStickyFolders.tsx";
import {
  FolderIcon,
  FolderOpenIcon,
  GitCommitVerticalIcon,
} from "./file-tree/icons.tsx";
import {
  copyTextToClipboard,
  getFileManagerOpenLabel,
  getFileManagerRevealLabel,
} from "./file-tree/helpers.ts";
import {
  filterChangedRows,
  getChildDepth,
  getAncestorDirectories,
  getRelativePath,
  type FileTreeRow,
} from "./file-tree/model.ts";
import { useMenuController } from "./file-tree/menuController.ts";
import { getWatchPaths, useFileTreeData } from "./file-tree/useFileTreeData.ts";
import { useFileSearchIndex } from "./file-tree/useFileSearchIndex.ts";
import {
  useStickyFolders,
  type StickyFolderItem,
} from "./file-tree/useStickyFolders.ts";
import type { FileEntry } from "../../core/panelService.ts";
import type { FileTreeRowHandlers } from "./file-tree/FileTreeRow.tsx";

/** 树列宽度边界（ZCode FileManagerPane：minSize 160px / maxSize 60%）。 */
const TREE_MIN_WIDTH_PX = 160;
const TREE_MAX_RATIO = 0.6;
const TREE_DEFAULT_RATIO = 0.5;
/** 分割布局持久化（ZCode useDefaultLayout("file-manager-layout") 的
 *  desktop 等价；按根路径隔离，全局 localStorage）。 */
const FILE_SPLIT_STORAGE_PREFIX = "aaw-desktop/file-split/";

interface FileSplitPref {
  ratio: number;
  visible: boolean;
}

function readSplitPref(root: string): FileSplitPref {
  try {
    const raw = localStorage.getItem(
      `${FILE_SPLIT_STORAGE_PREFIX}${pathKey(root)}`,
    );
    if (!raw) return { ratio: TREE_DEFAULT_RATIO, visible: true };
    const parsed = JSON.parse(raw) as Partial<FileSplitPref>;
    return {
      ratio:
        typeof parsed.ratio === "number" && Number.isFinite(parsed.ratio)
          ? Math.min(TREE_MAX_RATIO, Math.max(0.15, parsed.ratio))
          : TREE_DEFAULT_RATIO,
      visible: parsed.visible !== false,
    };
  } catch {
    return { ratio: TREE_DEFAULT_RATIO, visible: true };
  }
}

function writeSplitPref(root: string, pref: FileSplitPref): void {
  try {
    localStorage.setItem(
      `${FILE_SPLIT_STORAGE_PREFIX}${pathKey(root)}`,
      JSON.stringify(pref),
    );
  } catch {
    /* 配额不阻断。 */
  }
}

export function FileTree({
  root,
  external = false,
}: {
  root: string;
  external?: boolean;
  /** 兼容保留（RightPanel 仍传入）：树内点击不再外开 tab——ZCode 形态是
   *  树 + 并列预览区，点击文件只在预览区换内容（见 preview 状态）。 */
  onOpen?: (entry: FileEntry) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingRevealKeyRef = useRef<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    path: string;
    line?: number;
  } | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [showBottomMask, setShowBottomMask] = useState(false);
  const [hasScrollable, setHasScrollable] = useState(false);
  const [manual, setManual] = useState(0);
  const [searchRefreshVersion, setSearchRefreshVersion] = useState(0);
  // 树/预览分割（ZCode ResizableHandle）：宽度比例持久化，拖拽期间以 px
  // 跟手（%列在拖动中会抖），松手折算回比例入库；双击复位。
  const [split, setSplit] = useState<FileSplitPref>(() => readSplitPref(root));
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const splitRowRef = useRef<HTMLDivElement | null>(null);
  const treeColRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    paneWidth: number;
  } | null>(null);
  const treeVisible = split.visible;
  // 拖拽期间用 px 跟手，静止时用比例（窗口缩放保持占比）。
  const treeBasis =
    dragWidth !== null ? `${dragWidth}px` : `${split.ratio * 100}%`;
  // 面包屑 portal 宿主（FilePreview headerPortalTo 目标）。
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const { menu, open: openMenu, dismiss: dismissMenu } = useMenuController();

  const tree = useFileTreeData({ root, gitEnabled: !external });
  const { loadDirectory, refreshAll, setExpandedKeys } = tree;
  const watch = usePanelWatch(
    getWatchPaths(root, tree.expandedKeys),
    !external,
  );
  const agentRevision = useAgentRevision(root, !external);

  const rootKey = tree.rootKey;
  // 换根时在渲染期直接调整本地状态（React 官方推荐的 prop 变化复位模式）：
  // 组件常被外部 key 重挂，这里兜底 prop 换根。
  const [lastRootKey, setLastRootKey] = useState(rootKey);
  if (lastRootKey !== rootKey) {
    setLastRootKey(rootKey);
    setSelectedKey(null);
    setPreview(null);
    setFileSearchQuery("");
    setChangedOnly(false);
    setSearchRefreshVersion(0);
    setSplit(readSplitPref(root));
    pendingRevealKeyRef.current = null;
  }
  const title = useMemo(() => {
    const leaf = normalizePath(root).split("/").filter(Boolean).at(-1);
    return leaf || "Workspace";
  }, [root]);

  // 失效信号：窗口 focus / 面板 watch / agent 工具完成 → 整树静默刷新
  // （重读根 + 已展开目录 + Git 状态）。
  const refreshSignal = `${manual}:${watch.revision}:${agentRevision}`;
  const initialRefreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === initialRefreshSignalRef.current) return;
    initialRefreshSignalRef.current = refreshSignal;
    void refreshAll();
  }, [refreshAll, refreshSignal]);

  useEffect(() => {
    if (external) return;
    const refresh = (): void => setManual((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [external]);

  useEffect(() => {
    if (!tree.gitStatusAvailable) setChangedOnly(false);
  }, [tree.gitStatusAvailable]);

  // 根目录已有缓存时刷新失败只弹 toast，不用阻塞错误页盖掉旧树。
  const lastRootErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tree.rootLoaded || !tree.rootError) {
      lastRootErrorRef.current = null;
      return;
    }
    if (lastRootErrorRef.current === tree.rootError) return;
    lastRootErrorRef.current = tree.rootError;
    useToastStore.getState().push({
      message: `读取目录失败: ${tree.rootError}`,
      variant: "danger",
      dedupeKey: "file-tree-root-error",
    });
  }, [tree.rootError, tree.rootLoaded]);

  // reveal 源：desktop 的文件预览独占内容区，文件树仅在 files 分段可见，
  // 因此取右栏 store 中最近的文件页签——打开文件后切回 files 分段，树逐级
  // 展开并定位到该文件（ZCode activePreviewPath 的等价接线）。
  const activePreviewPath = useRightPanelStore((state) => {
    const panel = state.projects[pathKey(root)];
    if (!panel) return null;
    for (let index = panel.tabs.length - 1; index >= 0; index -= 1) {
      const tab = panel.tabs[index];
      if (tab !== undefined && tab.kind === "file") return tab.path;
    }
    return null;
  });
  useEffect(() => {
    if (!activePreviewPath || !insidePath(root, activePreviewPath)) return;
    let disposed = false;
    const ancestorDirectories = getAncestorDirectories(root, activePreviewPath);
    pendingRevealKeyRef.current = pathKey(activePreviewPath);
    setSelectedKey(pathKey(activePreviewPath));
    // store 里最近的文件页签同时恢复并列预览内容（分栏切换回来不丢预览）。
    setPreview({ path: activePreviewPath });
    setExpandedKeys((current) => {
      const next = new Set(current);
      for (const directory of ancestorDirectories) next.add(directory.key);
      return next;
    });
    void (async () => {
      for (const [index, directory] of ancestorDirectories.entries()) {
        if (disposed) return;
        await loadDirectory(directory.path, index + 1);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [activePreviewPath, loadDirectory, root, setExpandedKeys]);

  const normalizedQuery = fileSearchQuery.trim().toLowerCase();
  const hasFileSearchQuery = normalizedQuery.length > 0;
  const search = useFileSearchIndex({
    root,
    enabled: hasFileSearchQuery,
    refreshVersion: searchRefreshVersion,
  });

  const searchRows = useMemo<FileTreeRow[]>(() => {
    if (!hasFileSearchQuery) return [];
    return search.entries
      .filter((entry) =>
        entry.relativePath.toLowerCase().includes(normalizedQuery),
      )
      .map((entry) => ({
        type: entry.directory ? ("directory" as const) : ("file" as const),
        path: entry.path,
        key: entry.key,
        // 搜索结果来自全库平铺索引，同名文件靠相对路径区分。
        name: entry.relativePath,
        depth: 0,
        expanded: false,
        loaded: false,
        loading: false,
        error: null,
      }));
  }, [hasFileSearchQuery, normalizedQuery, search.entries]);

  const visibleRows = useMemo(() => {
    if (hasFileSearchQuery) {
      return changedOnly
        ? searchRows.filter(
            (row) => tree.gitStatusByPath.get(row.key) !== undefined,
          )
        : searchRows;
    }
    return changedOnly
      ? filterChangedRows(tree.rows, tree.gitStatusByPath)
      : tree.rows;
  }, [
    changedOnly,
    hasFileSearchQuery,
    searchRows,
    tree.gitStatusByPath,
    tree.rows,
  ]);

  // TanStack Virtual 自行维护测量状态，此组件不依赖 React Compiler 自动记忆化。
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
  });

  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const contentNode = node.firstElementChild;
    const updateScrollMask = (): void => {
      // 原生 scroll 回调直接写 CSS 变量：virtualizer 的 scrollOffset 要经过
      // React 渲染，拖拽滚动条时 mask 会落后一帧。
      listRef.current?.style.setProperty(
        FILE_TREE_MASK_OFFSET_PROPERTY,
        `${node.scrollTop}px`,
      );
      const hasOverflow = node.scrollHeight > node.clientHeight + 1;
      const isAtBottom =
        node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      setHasScrollable(hasOverflow);
      setShowBottomMask(hasOverflow && !isAtBottom);
    };
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };
    updateScrollMask();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        latestCallback = updateScrollMask;
        debouncedUpdate();
      });
      resizeObserver.observe(node);
      if (contentNode instanceof HTMLElement) resizeObserver.observe(contentNode);
    }
    node.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver?.disconnect();
      node.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tree.rootError, tree.rootLoaded, tree.rootLoading, visibleRows.length]);

  const toggleDirectory = useCallback(
    (row: FileTreeRow) => {
      if (row.type !== "directory") return;
      setExpandedKeys((current) => {
        const next = new Set(current);
        if (next.has(row.key)) {
          // 折叠只移除本行（含 compact 链）的展开态；子孙展开记忆与目录
          // 快照保留，重开不需逐层重读。
          for (const key of row.compactedKeys ?? [row.key]) next.delete(key);
          return next;
        }
        next.add(row.key);
        return next;
      });
      if (!row.expanded) {
        // compact 行的 depth 是视觉深度；用物理路径深度写入新加载节点。
        void loadDirectory(row.path, getChildDepth(rootKey, row.key));
      }
    },
    [loadDirectory, rootKey, setExpandedKeys],
  );

  const revealSearchDirectory = useCallback(
    (row: FileTreeRow) => {
      if (row.type !== "directory") return;
      const chain = [
        ...getAncestorDirectories(root, row.path),
        { path: row.path, key: row.key },
      ];
      pendingRevealKeyRef.current = row.key;
      setSelectedKey(row.key);
      setExpandedKeys((current) => {
        const next = new Set(current);
        for (const directory of chain) next.add(directory.key);
        return next;
      });
      // 搜索结果是平铺索引，不受展开态驱动；先回树态再逐级加载，目标目录
      // 才会在懒加载树中可见并保持展开。
      setFileSearchQuery("");
      void (async () => {
        for (const [index, directory] of chain.entries()) {
          await loadDirectory(directory.path, index + 1);
        }
      })();
    },
    [loadDirectory, root, setExpandedKeys],
  );

  const directoryAction = useCallback(
    (row: FileTreeRow) => {
      if (hasFileSearchQuery) {
        revealSearchDirectory(row);
        return;
      }
      toggleDirectory(row);
    },
    [hasFileSearchQuery, revealSearchDirectory, toggleDirectory],
  );

  /** ZCode 形态：树行点击 = 选中 pill + 并列预览区换内容，不开 tab、不遮挡树。 */
  const openPrimary = useCallback(
    (row: FileTreeRow) => {
      if (row.type === "directory") {
        directoryAction(row);
        return;
      }
      if (tree.gitStatusByPath.get(row.key) === "deleted") {
        // deleted 虚拟行来自 Git 状态补全，真实文件已不存在，只选中不打开。
        return;
      }
      setPreview({ path: row.path });
    },
    [directoryAction, tree.gitStatusByPath],
  );

  /** 预览面包屑层级点击：清搜索、逐级展开回树态并定位该目录。 */
  const navigateToDirectory = useCallback(
    (path: string) => {
      const chain = getAncestorDirectories(root, path);
      pendingRevealKeyRef.current = pathKey(path);
      setSelectedKey(pathKey(path));
      setFileSearchQuery("");
      setExpandedKeys((current) => {
        const next = new Set(current);
        for (const directory of chain) next.add(directory.key);
        next.add(pathKey(path));
        return next;
      });
      void (async () => {
        for (const [index, directory] of chain.entries()) {
          await loadDirectory(directory.path, index + 1);
        }
        await loadDirectory(path, chain.length + 1);
      })();
    },
    [loadDirectory, root, setExpandedKeys],
  );

  /** 预览正文内链（markdown 链接等）：预览区换内容 + 树逐级展开定位。 */
  const openPreviewPath = useCallback(
    (path: string, line?: number) => {
      setPreview({ path, line });
      const ancestorDirectories = getAncestorDirectories(root, path);
      pendingRevealKeyRef.current = pathKey(path);
      setSelectedKey(pathKey(path));
      setExpandedKeys((current) => {
        const next = new Set(current);
        for (const directory of ancestorDirectories) next.add(directory.key);
        return next;
      });
      void (async () => {
        for (const [index, directory] of ancestorDirectories.entries()) {
          await loadDirectory(directory.path, index + 1);
        }
      })();
    },
    [loadDirectory, root, setExpandedKeys],
  );

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, row: FileTreeRow) => {
      if (event.key === "Enter") {
        event.preventDefault();
        openPrimary(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded || hasFileSearchQuery) directoryAction(row);
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        toggleDirectory(row);
      }
    },
    [directoryAction, hasFileSearchQuery, openPrimary, toggleDirectory],
  );

  const copyPath = useCallback(async (text: string) => {
    const ok = await copyTextToClipboard(text);
    useToastStore.getState().push({
      message: ok ? "已复制" : "复制失败",
      variant: ok ? "ok" : "danger",
      dedupeKey: "file-tree-copy",
    });
  }, []);

  const revealEntry = useCallback(async (row: FileTreeRow) => {
    try {
      if (row.type === "directory") await openPath(row.path);
      else await revealItemInDir(row.path);
    } catch {
      useToastStore.getState().push({
        message: "无法打开该条目",
        variant: "danger",
      });
    }
  }, []);

  const openWorkspaceInFileManager = useCallback(async () => {
    try {
      await openPath(root);
    } catch {
      useToastStore.getState().push({
        message: "无法打开该条目",
        variant: "danger",
      });
    }
  }, [root]);

  const openRowMenu = useCallback(
    (row: FileTreeRow, x: number, y: number) => {
      setSelectedKey(row.key);
      const deleted =
        row.type === "file" &&
        tree.gitStatusByPath.get(row.key) === "deleted";
      openMenu(
        `row:${row.key}`,
        row.name,
        [
          {
            id: "open",
            label: "打开",
            disabled: deleted,
            onSelect: () => {
              // 菜单快照可能滞后，按 key 取最新行再执行主动作。
              const current =
                tree.rows.find((item) => item.key === row.key) ?? row;
              openPrimary(current);
            },
          },
          { type: "separator" },
          {
            id: "reveal",
            label: getFileManagerRevealLabel(),
            disabled: deleted,
            onSelect: () => void revealEntry(row),
          },
          {
            id: "copy-absolute-path",
            label: "复制绝对路径",
            onSelect: () => void copyPath(row.path),
          },
          {
            id: "copy-relative-path",
            label: "复制相对路径",
            onSelect: () => void copyPath(getRelativePath(root, row.path)),
          },
        ],
        { x, y, side: "bottom" },
      );
    },
    [copyPath, openMenu, openPrimary, revealEntry, root, tree.gitStatusByPath, tree.rows],
  );

  const openHeaderMenu = useCallback(
    (anchor: DOMRect) => {
      openMenu(
        "header",
        "更多",
        [
          {
            id: "open-in-file-manager",
            label: getFileManagerOpenLabel(),
            icon: <FolderOpenIcon className="size-4" />,
            onSelect: () => void openWorkspaceInFileManager(),
          },
          {
            id: "copy-path",
            label: "复制路径",
            icon: <CopyIcon className="size-4" />,
            onSelect: () => void copyPath(root),
          },
        ],
        { x: anchor.right, y: anchor.bottom, side: "bottom", align: "end" },
      );
    },
    [copyPath, openMenu, openWorkspaceInFileManager, root],
  );

  const handlers = useMemo<FileTreeRowHandlers>(
    () => ({
      onSelect: (row) => setSelectedKey(row.key),
      onToggleDirectory: directoryAction,
      onOpenFile: openPrimary,
      onOpenContextMenu: openRowMenu,
      onKeyDown: handleRowKeyDown,
    }),
    [directoryAction, handleRowKeyDown, openPrimary, openRowMenu],
  );

  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
  const stickyItems = useStickyFolders({
    rows: visibleRows,
    scrollOffset,
    enabled: hasScrollable && !hasFileSearchQuery,
  });
  const revealStickyRow = useCallback(
    (item: StickyFolderItem) =>
      rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );

  // reveal 后行出现在虚拟列表中时滚动定位（数据逐层到达，多次尝试直到命中）。
  useEffect(() => {
    const targetKey = pendingRevealKeyRef.current;
    if (!targetKey || visibleRows.length === 0) return;
    const index = visibleRows.findIndex((row) => row.key === targetKey);
    if (index >= 0) {
      rowVirtualizer.scrollToIndex(index, { align: "auto" });
      pendingRevealKeyRef.current = null;
    }
  }, [rowVirtualizer, visibleRows]);

  const blockingRootError = tree.rootLoaded ? null : tree.rootError;
  const showInitialLoading = !tree.rootLoaded && blockingRootError === null;
  const hasActiveFilter = hasFileSearchQuery || changedOnly;
  const refreshInProgress =
    tree.rootLoading || tree.refreshing || search.loading;
  const scrollContainerStyle = useMemo<CSSProperties>(() => {
    const mask = showBottomMask
      ? {
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
          maskImage:
            "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
          WebkitMaskRepeat: "no-repeat" as const,
          maskRepeat: "no-repeat" as const,
          WebkitMaskSize: "100% 100%",
          maskSize: "100% 100%",
        }
      : undefined;
    return { ...mask, overflowAnchor: "none" as const };
  }, [showBottomMask]);

  const commitSplit = useCallback(
    (next: FileSplitPref) => {
      setSplit(next);
      writeSplitPref(root, next);
    },
    [root],
  );
  const onSplitPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const paneWidth = splitRowRef.current?.clientWidth ?? 0;
      const startWidth = treeColRef.current?.clientWidth ?? 0;
      if (paneWidth <= 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      splitDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        paneWidth,
      };
    },
    [],
  );
  const onSplitPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = splitDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const maxWidth = Math.max(
        TREE_MIN_WIDTH_PX,
        Math.floor(drag.paneWidth * TREE_MAX_RATIO),
      );
      const next = Math.min(
        maxWidth,
        Math.max(
          TREE_MIN_WIDTH_PX,
          drag.startWidth + event.clientX - drag.startX,
        ),
      );
      dragWidthRef.current = next;
      setDragWidth(next);
    },
    [],
  );
  const onSplitPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = splitDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      splitDragRef.current = null;
      const width = dragWidthRef.current;
      dragWidthRef.current = null;
      setDragWidth(null);
      if (width !== null) {
        commitSplit({
          ratio: Math.min(
            TREE_MAX_RATIO,
            Math.max(0.15, width / drag.paneWidth),
          ),
          visible: true,
        });
      }
    },
    [commitSplit],
  );

  return (
    <section className="flex h-full min-h-0 flex-col text-ink">
      {/* 头部行（ZCode FileManagerPane h-10 头部，图1/2 形态）：⇄ 左置承载
          目录显隐（未选文件时行仍在，仅显「文件」标题）；面包屑经
          headerPortalTo portal 进来，FilePreview 只传内片段、壳由本行提供。 */}
      <div className="flex h-10 shrink-0 items-center border-b border-line bg-surface/30">
        <button
          type="button"
          aria-label={treeVisible ? "收起目录" : "展开目录"}
          title={treeVisible ? "收起目录" : "展开目录"}
          aria-pressed={treeVisible}
          className="ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
          onClick={() => commitSplit({ ...split, visible: !treeVisible })}
        >
          {treeVisible ? (
            <PanelLeftCloseIcon className="size-4" />
          ) : (
            <PanelLeftOpenIcon className="size-4" />
          )}
        </button>
        <div
          ref={setHeaderContainer}
          data-file-manager-header=""
          // flex 行内再 flex：FilePreview portal 进来的是内片段（面包屑
          // viewport + 动作钮），没有本层 flex 会垂直堆叠成两行。
          className="flex min-w-0 flex-1 items-center"
        >
          {!preview ? (
            <span className="px-3 text-sm text-ink-subtle">文件</span>
          ) : null}
        </div>
      </div>
      {watch.error && !external ? (
        <p role="alert" className="p-2 text-xs text-warn-ink">
          {watch.error}
        </p>
      ) : null}
      <div ref={splitRowRef} className="flex min-h-0 flex-1 flex-row">
        {treeVisible ? (
          <>
            <div
              ref={treeColRef}
              className="flex min-h-0 shrink-0 flex-col"
              style={{ width: treeBasis }}
            >
              {/* 搜索在目录模组内（ZCode 图1/2：树列宽，不横跨预览列） */}
              <div className="flex shrink-0 items-center px-2 pb-1.5 pt-2">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-subtlest" />
                  <input
                    type="text"
                    value={fileSearchQuery}
                    placeholder="搜索文件..."
                    aria-label="搜索文件"
                    className="h-6 w-full rounded-md border border-line bg-transparent pl-7 pr-7 text-xs text-ink outline-none transition-colors placeholder:text-ink-subtlest hover:border-line-strong focus-visible:border-line-strong"
                    onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
                  />
                  {fileSearchQuery.length > 0 ? (
                    <button
                      type="button"
                      aria-label="清空文件搜索"
                      title="清空文件搜索"
                      className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-ink-subtlest transition-colors hover:bg-surface-hover hover:text-ink"
                      onClick={() => setFileSearchQuery("")}
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center px-2 pb-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <h3 className="min-w-0 truncate py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-ink-subtlest">
                    {title}
                  </h3>
                </div>
                <button
                  type="button"
                  aria-label="更多"
                  title="更多"
                  aria-haspopup="menu"
                  className="flex size-6 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
                  onClick={(event) => openHeaderMenu(event.currentTarget.getBoundingClientRect())}
                >
                  <EllipsisIcon className="size-3.5" />
                </button>
                {tree.gitStatusAvailable ? (
                  <button
                    type="button"
                    aria-pressed={changedOnly}
                    aria-label={changedOnly ? "显示全部文件" : "仅显示变更文件"}
                    title={changedOnly ? "显示全部文件" : "仅显示变更文件"}
                    className={`flex size-6 items-center justify-center rounded-md transition-colors hover:bg-surface-hover hover:text-ink ${
                      changedOnly ? "bg-selected text-ink" : "text-ink-subtle"
                    }`}
                    onClick={() => setChangedOnly((current) => !current)}
                  >
                    <GitCommitVerticalIcon className="size-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="刷新文件树"
                  title="刷新文件树"
                  disabled={tree.refreshing}
                  className="flex size-6 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setManual((value) => value + 1);
                    if (hasFileSearchQuery) {
                      setSearchRefreshVersion((value) => value + 1);
                    }
                  }}
                >
                  <RefreshIcon
                    className={`size-3.5 ${refreshInProgress ? "animate-spin" : ""}`}
                  />
                </button>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                  ref={scrollRef}
                  className="h-full min-h-0 overflow-auto px-2"
                  style={scrollContainerStyle}
                >
                  <FileTreeStickyFolders
                    items={stickyItems}
                    selectedKey={selectedKey}
                    gitStatusByPath={tree.gitStatusByPath}
                    root={root}
                    handlers={handlers}
                    onRevealRow={revealStickyRow}
                  />
                  <FileTreeList
                    rootError={hasFileSearchQuery ? search.error : blockingRootError}
                    showInitialLoading={
                      showInitialLoading ||
                      (hasFileSearchQuery && search.loading && !search.loaded)
                    }
                    rows={visibleRows}
                    virtualItems={virtualItems}
                    listRef={handleListRef}
                    stickyFolderCount={stickyItems.length}
                    totalSize={rowVirtualizer.getTotalSize()}
                    emptyTitle={hasActiveFilter ? "没有匹配的文件。" : "当前目录为空。"}
                    title={title}
                    root={root}
                    selectedKey={selectedKey}
                    gitStatusByPath={tree.gitStatusByPath}
                    handlers={handlers}
                    virtual={visibleRows.length > 100}
                  />
                  {tree.rootTruncated ? (
                    <p className="px-2 py-1 text-2xs text-warn-ink">
                      此目录超过 10000 项，仅显示部分条目
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            {/* 分割条（ZCode ResizableHandle 同交互）：拖拽/方向键调宽，
                双击复位；指示条黑 50%（ColumnResizer 同款），静息只留灰中线，
                预览列不再自带 border-l。 */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录列宽度"
              tabIndex={0}
              className={`group relative w-px shrink-0 cursor-col-resize touch-none bg-line outline-none after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:bg-ink-subtlest/50 after:opacity-0 after:content-[''] group-hover:after:opacity-100 group-focus-visible:after:opacity-100${
                dragWidth !== null ? " after:opacity-100" : ""
              }`}
              onDoubleClick={() =>
                commitSplit({ ...split, ratio: TREE_DEFAULT_RATIO })
              }
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const paneWidth = splitRowRef.current?.clientWidth ?? 0;
                if (paneWidth <= 0) return;
                const current = treeColRef.current?.clientWidth ?? 0;
                const next = Math.min(
                  Math.max(TREE_MIN_WIDTH_PX, Math.floor(paneWidth * TREE_MAX_RATIO)),
                  Math.max(TREE_MIN_WIDTH_PX, current + (event.key === "ArrowLeft" ? -16 : 16)),
                );
                commitSplit({ ...split, ratio: next / paneWidth });
              }}
              onPointerDown={onSplitPointerDown}
              onPointerMove={onSplitPointerMove}
              onPointerUp={onSplitPointerEnd}
              onPointerCancel={onSplitPointerEnd}
            />
          </>
        ) : null}
        {/* 预览区（ZCode PreviewPane 并列形态）：未选中文件显示空态，点击
            文件/预览内链只换预览内容；关闭路径 = 顶栏分段切换（面板级），
            预览区不放关闭钮。 */}
        <div aria-label="预览区" className="flex h-full min-w-0 flex-1 flex-col">
          {preview ? (
            <FilePreview
              key={`${preview.path}:${preview.line ?? 0}`}
              path={preview.path}
              project={root}
              line={preview.line}
              onOpen={openPreviewPath}
              onNavigate={navigateToDirectory}
              headerPortalTo={headerContainer}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <FolderIcon className="size-8 text-ink-ghost" />
              <p className="text-xs text-ink-subtlest">
                从目录中选择一个文件
              </p>
            </div>
          )}
        </div>
      </div>
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismissMenu}
        />
      )}
    </section>
  );
}
