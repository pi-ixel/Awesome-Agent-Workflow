import type { PanelTool, PanelTab, ProjectPanel, RightPanelState } from "../../contracts/workbenchLayout.ts";
import type { HostStorage } from "../../contracts/host.ts";
import type { WorkbenchNavigationGuard } from "../../contracts/workbench.ts";
/** 项目右栏仅持有引用和展示偏好，不保存文件正文或执行状态。 */
import { createStore, type StoreApi } from "zustand";
import {
  isAbsolutePath,
  normalizePath,
  pathKey,
} from "../../shared/panelPaths.ts";
import { reviewSources } from "../../contracts/git.ts";

/** 单例 kind（不含 new-tab：占位 tab 不入最近关闭栈，也不落盘）。 */
const SINGLETON_KINDS: readonly PanelTool[] = ["aaw", "files", "git"];

/** 最近关闭栈容量（新→旧）。 */
const RECENTLY_CLOSED_CAP = 10;
export const emptyPanel: ProjectPanel = {
  open: false,
  width: 420,
  active: "",
  tabs: [],
};
const storageKey = "aaw-desktop/right-panel/zcode-v1";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validOpenedAt(value: { openedAt?: unknown }): boolean {
  return (
    value.openedAt === undefined ||
    (typeof value.openedAt === "number" && Number.isFinite(value.openedAt))
  );
}
function restoreToolViews(
  data: Record<string, unknown>,
): ProjectPanel["toolViews"] {
  const views: NonNullable<ProjectPanel["toolViews"]> = {};
  const stored = record(data.toolViews) ? data.toolViews : {};
  for (const tool of SINGLETON_KINDS) {
    const view = stored[tool];
    if (typeof view === "string") views[tool] = view;
  }
  // Version 1 layouts stored the Workflow view directly on the panel.
  if (views.aaw === undefined && data.aawSegment === "launch")
    views.aaw = data.aawSegment;
  return Object.keys(views).length ? views : undefined;
}
function validTab(value: unknown): value is PanelTab {
  if (!record(value) || typeof value.id !== "string") return false;
  // 单例型接受 {id,kind} 无 path；id 恒等于 kind；new-tab 永不恢复（会话级占位）。
  if (
    typeof value.kind === "string" &&
    (SINGLETON_KINDS as readonly string[]).includes(value.kind)
  )
    return value.id === value.kind && validOpenedAt(value);
  if (
    typeof value.path !== "string" ||
    !isAbsolutePath(value.path) ||
    !validOpenedAt(value)
  )
    return false;
  if (value.kind === "file")
    return (
      value.line === undefined ||
      (typeof value.line === "number" &&
        Number.isFinite(value.line) &&
        value.line > 0)
    );
  if (value.kind === "directory") return true;
  if (
    value.kind !== "diff" ||
    typeof value.repoRoot !== "string" ||
    !record(value.change)
  )
    return false;
  return (
    typeof value.change.path === "string" &&
    (typeof value.change.oldPath === "string" ||
      value.change.oldPath === null) &&
    typeof value.change.status === "string" &&
    ["staged", "unstaged", "untracked", "conflict", "branch"].includes(
      String(value.change.source),
    )
  );
}
export function restorePanels(
  raw: string | null,
): Record<string, ProjectPanel> {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!record(value) || value.version !== 1 || !record(value.projects))
      return {};
    const projects: Record<string, ProjectPanel> = {};
    for (const [path, data] of Object.entries(value.projects).slice(-50)) {
      if (!isAbsolutePath(path) || !record(data) || !Array.isArray(data.tabs))
        continue;
      const tabs = (data.tabs as unknown[]).filter(validTab).slice(0, 100);
      const active = typeof data.active === "string" ? data.active : "";
      // 旧数据迁移：active 指向单例工具而 tabs 缺对应单例时自动补建（无缝升级）。
      const migrated: PanelTab[] =
        (SINGLETON_KINDS as readonly string[]).includes(active) &&
        !tabs.some((tab) => tab.id === active)
          ? [...tabs, { id: active, kind: active } as PanelTab]
          : tabs;
      // active 越界回落到首个 tab；无 tab 时回落到起始页（""）。
      const resolvedActive = migrated.some((tab) => tab.id === active)
        ? active
        : (migrated[0]?.id ?? "");
      projects[pathKey(path)] = {
        open: data.open === true,
        width:
          typeof data.width === "number" && Number.isFinite(data.width)
            ? Math.min(800, Math.max(300, data.width))
            : 420,
        gitWidth:
          typeof data.gitWidth === "number" && Number.isFinite(data.gitWidth)
            ? Math.min(2400, Math.max(300, data.gitWidth))
            : undefined,
        active: resolvedActive,
        sizeRatio:
          typeof data.sizeRatio === "number" && Number.isFinite(data.sizeRatio)
            ? Math.min(0.9, Math.max(0.1, data.sizeRatio))
            : undefined,
        tabs: migrated,
        toolViews: restoreToolViews(data),
        gitSource:
          reviewSources.find(([id]) => id === data.gitSource)?.[0] ??
          "unstaged",
      };
    }
    return projects;
  } catch {
    return {};
  }
}
function load(storage: HostStorage): Record<string, ProjectPanel> {
  try {
    const current = storage.getItem(storageKey);
    if (current !== null) return restorePanels(current);
    // 首次迁移只重置布局偏好；保留文件标签、工具选择及业务引用。
    const previous = restorePanels(
      storage.getItem("aaw-desktop/right-panel/v1"),
    );
    return Object.fromEntries(
      Object.entries(previous).map(([key, panel]) => [
        key,
        {
          ...panel,
          open: false,
          width: 420,
          gitWidth: undefined,
          sizeRatio: undefined,
        },
      ]),
    );
  } catch {
    return {};
  }
}
function persist(
  storage: HostStorage,
  projects: Record<string, ProjectPanel>,
): void {
  try {
    // 会话级状态不落盘（对齐 ZCode taskSidePaneMemory 内存语义）：
    // recentlyClosed / fullView / new-tab 占位剥离后写盘，旧读取方兼容。
    const serialized = Object.fromEntries(
      Object.entries(projects).map(([key, panel]) => [
        key,
        {
          ...panel,
          recentlyClosed: undefined,
          fullView: undefined,
          tabs: panel.tabs.filter((tab) => tab.kind !== "new-tab"),
        },
      ]),
    );
    storage.setItem(
      storageKey,
      JSON.stringify({ version: 1, projects: serialized }),
    );
  } catch {
    /* 存储配额不阻断当前使用。 */
  }
}
const noop = () => {};
export const emptyRightPanelState: RightPanelState = {
  projects: {},
  tool: noop,
  open: noop,
  collapse: noop,
  width: noop,
  resize: noop,
  activate: noop,
  openNewTab: noop,
  openFile: noop,
  openDirectory: noop,
  openDiff: noop,
  closeTab: noop,
  closeOthers: noop,
  closeAll: noop,
  moveTab: noop,
  reopenClosed: noop,
  fullViewOpen: noop,
  fullViewPatch: noop,
  fullViewExit: noop,
  gitSource: noop,
  setToolView: noop,
};
export function createRightPanelStore(
  storage: HostStorage,
  guard: WorkbenchNavigationGuard,
) {
  let active = true;
  const store = createStore<RightPanelState>((set, get) => {
    const update = (
      project: string,
      fn: (panel: ProjectPanel) => ProjectPanel,
    ): void => {
      if (!active) return;
      const current = get().projects[pathKey(project)] ?? emptyPanel;
      const next = fn(current);
      const leaving =
        next.active !== current.active ||
        (current.open && !next.open) ||
        current.tabs.some(
          (tab) => !next.tabs.some((item) => item.id === tab.id),
        );
      if (leaving && !guard.guard(() => update(project, fn))) return;
      set((state) => {
        const key = pathKey(project);
        const projects = {
          ...state.projects,
          [key]: next,
        };
        persist(storage, projects);
        return { projects };
      });
    };
    /**
     * 通用开 tab：目标已存在→原位更新载荷并激活（占位保留）；
     * 目标不存在且激活 tab 是 new-tab 占位→原位替换（「+号打开占位、提交
     * 路径原位替换」）；否则追加到末尾。openedAt 记首次打开时间。
     */
    const openTab = (project: string, tab: PanelTab): void =>
      update(project, (panel) => {
        const stamped: PanelTab = { ...tab, openedAt: Date.now() };
        if (panel.tabs.some((item) => item.id === tab.id)) {
          return {
            ...panel,
            open: true,
            active: tab.id,
            tabs: panel.tabs.map((item) =>
              item.id === tab.id
                ? { ...stamped, openedAt: item.openedAt ?? stamped.openedAt }
                : item,
            ),
          };
        }
        if (panel.active === "new-tab") {
          const index = panel.tabs.findIndex((item) => item.kind === "new-tab");
          if (index >= 0) {
            const tabs = [...panel.tabs];
            tabs.splice(index, 1, stamped);
            return { ...panel, open: true, active: tab.id, tabs };
          }
        }
        return {
          ...panel,
          open: true,
          active: tab.id,
          tabs: [...panel.tabs, stamped],
        };
      });
    /** 关闭入栈（新→旧，cap 10）；new-tab 占位不入栈。 */
    const pushClosed = (
      panel: ProjectPanel,
      tabs: readonly PanelTab[],
    ): ProjectPanel["recentlyClosed"] => {
      const closed = tabs.filter((tab) => tab.kind !== "new-tab");
      if (closed.length === 0) return panel.recentlyClosed;
      const now = Date.now();
      return [
        ...closed.map((tab) => ({ tab, closedAt: now })),
        ...(panel.recentlyClosed ?? []),
      ].slice(0, RECENTLY_CLOSED_CAP);
    };
    const singletonTab = (kind: PanelTool): PanelTab =>
      kind === "aaw"
        ? { id: "aaw", kind: "aaw" }
        : kind === "files"
          ? { id: "files", kind: "files" }
          : { id: "git", kind: "git" };
    return {
      projects: load(storage),
      resize: (project, ratio) =>
        update(project, (panel) => ({
          ...panel,
          sizeRatio: Math.min(0.9, Math.max(0.1, ratio)),
        })),
      setToolView: (project, tool, view) =>
        update(project, (panel) =>
          panel.toolViews?.[tool] === view
            ? panel
            : { ...panel, toolViews: { ...panel.toolViews, [tool]: view } },
        ),
      gitSource: (project, source) =>
        update(project, (panel) => ({
          ...panel,
          gitSource: source,
          gitReveal: { source, revision: (panel.gitReveal?.revision ?? 0) + 1 },
        })),
      tool: (project, tool) => openTab(project, singletonTab(tool)),
      open: (project) => update(project, (panel) => ({ ...panel, open: true })),
      collapse: (project) =>
        // 面板关闭自动退出完整视图的唯一出口：Esc / 遮罩 / ContextBar 开关全汇经此处。
        update(project, (panel) =>
          panel.fullView === undefined && !panel.open
            ? panel
            : { ...panel, open: false, fullView: undefined },
        ),
      width: (project, width) =>
        update(project, (panel) => ({
          ...panel,
          ...(panel.active === "git"
            ? { gitWidth: Math.min(2400, Math.max(300, width)) }
            : { width: Math.min(800, Math.max(300, width)) }),
        })),
      activate: (project, id) =>
        update(project, (panel) => ({ ...panel, active: id, open: true })),
      openNewTab: (project) =>
        update(project, (panel) => ({
          ...panel,
          open: true,
          active: "new-tab",
          tabs: panel.tabs.some((tab) => tab.kind === "new-tab")
            ? panel.tabs
            : [
                ...panel.tabs,
                { id: "new-tab", kind: "new-tab", openedAt: Date.now() },
              ],
        })),
      openFile: (project, path, line) =>
        openTab(project, {
          id: `file:${pathKey(path)}`,
          kind: "file",
          path: normalizePath(path),
          ...(line ? { line } : {}),
        }),
      openDirectory: (project, path) =>
        openTab(project, {
          id: `directory:${pathKey(path)}`,
          kind: "directory",
          path: normalizePath(path),
        }),
      openDiff: (project, repoRoot, change) =>
        openTab(project, {
          id: `diff:${pathKey(repoRoot)}:${change.source}:${change.path}`,
          kind: "diff",
          path: normalizePath(`${repoRoot}/${change.path}`),
          repoRoot,
          change,
        }),
      closeTab: (project, id) =>
        update(project, (panel) => {
          const index = panel.tabs.findIndex((tab) => tab.id === id);
          if (index < 0) return panel;
          const closed = panel.tabs[index]!;
          const tabs = panel.tabs.filter((_, at) => at !== index);
          return {
            ...panel,
            tabs,
            recentlyClosed: pushClosed(panel, [closed]),
            // 被关的是激活 tab → 优先激活右邻，末位才左落，无则起始页
            // （ZCode：Math.min(closingIndex, nextTabs.length - 1) 同款右落优先）。
            active:
              panel.active === id
                ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? "")
                : panel.active,
          };
        }),
      closeOthers: (project, id) =>
        update(project, (panel) => {
          const keep = panel.tabs.find((tab) => tab.id === id);
          if (!keep) return panel;
          return {
            ...panel,
            tabs: [keep],
            active: id,
            recentlyClosed: pushClosed(
              panel,
              panel.tabs.filter((tab) => tab.id !== id),
            ),
          };
        }),
      closeAll: (project) =>
        update(project, (panel) => ({
          ...panel,
          tabs: [],
          active: "",
          recentlyClosed: pushClosed(panel, panel.tabs),
        })),
      moveTab: (project, id, toIndex) =>
        update(project, (panel) => {
          const from = panel.tabs.findIndex((tab) => tab.id === id);
          if (from < 0) return panel;
          const index = Math.max(0, Math.min(toIndex, panel.tabs.length - 1));
          if (index === from) return panel;
          const tabs = [...panel.tabs];
          const [moved] = tabs.splice(from, 1);
          tabs.splice(index, 0, moved!);
          return { ...panel, tabs };
        }),
      reopenClosed: (project, id) =>
        update(project, (panel) => {
          const entry = panel.recentlyClosed?.find(
            (item) => item.tab.id === id,
          );
          if (!entry) return panel;
          return {
            ...panel,
            open: true,
            active: entry.tab.id,
            // diff tab 携完整 GitChange 载荷恢复；陈旧快照由 GitDiffView 渲染兜底。
            tabs: panel.tabs.some((tab) => tab.id === entry.tab.id)
              ? panel.tabs
              : [...panel.tabs, entry.tab],
            recentlyClosed: panel.recentlyClosed?.filter(
              (item) => item.tab.id !== id,
            ),
          };
        }),
      fullViewOpen: (project, surface) =>
        update(project, (panel) => ({
          ...panel,
          // 进入固定态（ZCode SIDE_PANE_FULL_VIEW_ENTER_STATE model.ts:10-13）：
          // floating 复位 collapsed，anchor 保留用户上次的吸附位置。
          fullView: {
            surface,
            floating: "collapsed",
            anchor: panel.fullView?.anchor ?? "bottom-right",
          },
        })),
      fullViewPatch: (project, partial) =>
        update(project, (panel) =>
          panel.fullView
            ? { ...panel, fullView: { ...panel.fullView, ...partial } }
            : panel,
        ),
      fullViewExit: (project) =>
        update(project, (panel) =>
          panel.fullView ? { ...panel, fullView: undefined } : panel,
        ),
    };
  });
  const setState: StoreApi<RightPanelState>["setState"] = (state, replace) => {
    if (active) store.setState(state as RightPanelState, replace as true);
  };
  return {
    store: { ...store, setState },
    dispose() {
      active = false;
      store.setState(emptyRightPanelState, true);
    },
  };
}
