/** 项目右栏仅持有引用和展示偏好，不保存文件正文或执行状态。 */
import { create } from "zustand";
import { isAbsolutePath, normalizePath, pathKey } from "../core/panelPaths.ts";
import type { GitChange } from "../core/panelService.ts";
import { reviewSources, type ReviewSource } from "../core/gitReview.ts";

export type PanelTool = "aaw" | "files" | "git";
/** 单例 tab：id 恒等于 kind，天然去重（new-tab 为占位，不入 recentlyClosed）。 */
export type PanelSingletonKind = PanelTool | "new-tab";
export type PanelTab =
  | { id: string; kind: "file"; path: string; line?: number; openedAt?: number }
  | { id: string; kind: "directory"; path: string; openedAt?: number }
  | {
      id: string;
      kind: "diff";
      path: string;
      repoRoot: string;
      change: GitChange;
      openedAt?: number;
    }
  | { id: "aaw"; kind: "aaw"; openedAt?: number }
  | { id: "files"; kind: "files"; openedAt?: number }
  | { id: "git"; kind: "git"; openedAt?: number }
  | { id: "new-tab"; kind: "new-tab"; openedAt?: number };

/** 完整视图状态（ZCode side-pane-full-view/contract.ts:4-5/22-29 同形）。 */
export type PanelFullView = {
  surface: "conversation" | "side-pane";
  floating: "collapsed" | "expanded" | "minimized";
  anchor:
    | "top-left"
    | "top-right"
    | "left-center"
    | "right-center"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
};

/** 单例 kind（不含 new-tab：占位 tab 不入最近关闭栈，也不落盘）。 */
const SINGLETON_KINDS: readonly PanelTool[] = ["aaw", "files", "git"];

/** 最近关闭栈容量（新→旧）。 */
const RECENTLY_CLOSED_CAP = 10;

export interface ProjectPanel {
  open: boolean;
  width: number;
  gitWidth?: number;
  /** 页面控制只保存比例；旧像素尺寸仅用于兼容旧数据。 */
  sizeRatio?: number;
  active: string;
  tabs: readonly PanelTab[];
  gitSource?: ReviewSource;
  gitReveal?: { source: ReviewSource; revision: number };
  aawSegment?: "progress" | "launch";
  /** 最近关闭的 tab（新→旧，cap 10；会话级状态不落盘）。 */
  recentlyClosed?: { tab: PanelTab; closedAt: number }[];
  /** 完整视图状态（会话级状态不落盘）。 */
  fullView?: PanelFullView;
}
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
      const active =
        typeof data.active === "string" ? data.active : "";
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
        aawSegment: data.aawSegment === "launch" ? "launch" : "progress",
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
function load(): Record<string, ProjectPanel> {
  try {
    const current = localStorage.getItem(storageKey);
    if (current !== null) return restorePanels(current);
    // 首次迁移只重置布局偏好；保留文件标签、工具选择及业务引用。
    const previous = restorePanels(
      localStorage.getItem("aaw-desktop/right-panel/v1"),
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
function persist(projects: Record<string, ProjectPanel>): void {
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
    localStorage.setItem(
      storageKey,
      JSON.stringify({ version: 1, projects: serialized }),
    );
  } catch {
    /* 存储配额不阻断当前使用。 */
  }
}
interface RightPanelState {
  projects: Record<string, ProjectPanel>;
  tool: (project: string, tool: PanelTool) => void;
  /** 仅重开右栏（ContextBar 分栏开关），active/tabs 原样保留。 */
  open: (project: string) => void;
  collapse: (project: string) => void;
  width: (project: string, width: number) => void;
  resize: (project: string, ratio: number) => void;
  activate: (project: string, id: string) => void;
  openNewTab: (project: string) => void;
  openFile: (project: string, path: string, line?: number) => void;
  openDirectory: (project: string, path: string) => void;
  openDiff: (project: string, repoRoot: string, change: GitChange) => void;
  closeTab: (project: string, id: string) => void;
  closeOthers: (project: string, id: string) => void;
  closeAll: (project: string) => void;
  /** 拖动排序落位：把 id 移到 toIndex（越界夹取，激活态不变）。 */
  moveTab: (project: string, id: string, toIndex: number) => void;
  reopenClosed: (project: string, id: string) => void;
  fullViewOpen: (project: string, surface: PanelFullView["surface"]) => void;
  fullViewPatch: (project: string, partial: Partial<PanelFullView>) => void;
  fullViewExit: (project: string) => void;
  gitSource: (project: string, source: ReviewSource) => void;
  aawSegment: (project: string, segment: "progress" | "launch") => void;
}
export const useRightPanelStore = create<RightPanelState>((set) => {
  const update = (
    project: string,
    fn: (panel: ProjectPanel) => ProjectPanel,
  ): void => {
    set((state) => {
      const key = pathKey(project);
      const projects = {
        ...state.projects,
        [key]: fn(state.projects[key] ?? emptyPanel),
      };
      persist(projects);
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
        const index = panel.tabs.findIndex(
          (item) => item.kind === "new-tab",
        );
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
    projects: load(),
    resize: (project, ratio) =>
      update(project, (panel) => ({
        ...panel,
        sizeRatio: Math.min(0.9, Math.max(0.1, ratio)),
      })),
    aawSegment: (project, segment) =>
      update(project, (panel) => ({ ...panel, aawSegment: segment })),
    gitSource: (project, source) =>
      update(project, (panel) => ({
        ...panel,
        gitSource: source,
        gitReveal: { source, revision: (panel.gitReveal?.revision ?? 0) + 1 },
      })),
    tool: (project, tool) => openTab(project, singletonTab(tool)),
    open: (project) =>
      update(project, (panel) => ({ ...panel, open: true })),
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
