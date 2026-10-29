/** 项目右栏仅持有引用和展示偏好，不保存文件正文或执行状态。 */
import { create } from "zustand";
import { isAbsolutePath, normalizePath, pathKey } from "../core/panelPaths.ts";
import type { GitChange } from "../core/panelService.ts";
import { reviewSources, type ReviewSource } from "../core/gitReview.ts";

export type PanelTool = "aaw" | "files" | "git";
export type PanelTab =
  | { id: string; kind: "file"; path: string; line?: number }
  | { id: string; kind: "directory"; path: string }
  | {
      id: string;
      kind: "diff";
      path: string;
      repoRoot: string;
      change: GitChange;
    };
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
}
export const emptyPanel: ProjectPanel = {
  open: false,
  width: 420,
  active: "files",
  tabs: [],
};
const storageKey = "aaw-desktop/right-panel/zcode-v1";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validTab(value: unknown): value is PanelTab {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.path !== "string" ||
    !isAbsolutePath(value.path)
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
        typeof data.active === "string" &&
        (["aaw", "files", "git"].includes(data.active) ||
          tabs.some((tab) => tab.id === data.active))
          ? data.active
          : "files";
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
        active,
        sizeRatio:
          typeof data.sizeRatio === "number" && Number.isFinite(data.sizeRatio)
            ? Math.min(0.9, Math.max(0.1, data.sizeRatio))
            : undefined,
        tabs,
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
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, projects }));
  } catch {
    /* 存储配额不阻断当前使用。 */
  }
}
interface RightPanelState {
  projects: Record<string, ProjectPanel>;
  tool: (project: string, tool: PanelTool) => void;
  collapse: (project: string) => void;
  width: (project: string, width: number) => void;
  resize: (project: string, ratio: number) => void;
  activate: (project: string, id: string) => void;
  openFile: (project: string, path: string, line?: number) => void;
  openDirectory: (project: string, path: string) => void;
  openDiff: (project: string, repoRoot: string, change: GitChange) => void;
  closeTab: (project: string, id: string) => void;
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
  const open = (project: string, tab: PanelTab): void =>
    update(project, (panel) => ({
      ...panel,
      open: true,
      active: tab.id,
      tabs: panel.tabs.some((item) => item.id === tab.id)
        ? panel.tabs.map((item) => (item.id === tab.id ? tab : item))
        : [...panel.tabs, tab],
    }));
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
    tool: (project, tool) =>
      update(project, (panel) => ({ ...panel, open: true, active: tool })),
    collapse: (project) =>
      update(project, (panel) => ({ ...panel, open: false })),
    width: (project, width) =>
      update(project, (panel) => ({
        ...panel,
        ...(panel.active === "git"
          ? { gitWidth: Math.min(2400, Math.max(300, width)) }
          : { width: Math.min(800, Math.max(300, width)) }),
      })),
    activate: (project, id) =>
      update(project, (panel) => ({ ...panel, active: id, open: true })),
    openFile: (project, path, line) =>
      open(project, {
        id: `file:${pathKey(path)}`,
        kind: "file",
        path: normalizePath(path),
        ...(line ? { line } : {}),
      }),
    openDirectory: (project, path) =>
      open(project, {
        id: `directory:${pathKey(path)}`,
        kind: "directory",
        path: normalizePath(path),
      }),
    openDiff: (project, repoRoot, change) =>
      open(project, {
        id: `diff:${pathKey(repoRoot)}:${change.source}:${change.path}`,
        kind: "diff",
        path: normalizePath(`${repoRoot}/${change.path}`),
        repoRoot,
        change,
      }),
    closeTab: (project, id) =>
      update(project, (panel) => ({
        ...panel,
        tabs: panel.tabs.filter((tab) => tab.id !== id),
        active: panel.active === id ? "files" : panel.active,
      })),
  };
});
