import type { PanelTab, ProjectPanel, RightPanelState } from "./types.ts";
import type { HostStorage } from "../../host/types.ts";
import type { PanelLayoutCompatibility, WorkbenchNavigationGuard } from "../types.ts";
/** 项目右栏仅持有引用和展示偏好，不保存文件正文或执行状态。 */
import { createStore, type StoreApi } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import { loadPanels, persistPanels } from "./panelStorage.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

/** 最近关闭栈容量（新→旧）。 */
const RECENTLY_CLOSED_CAP = 10;
export const emptyPanel: ProjectPanel = {
  open: false,
  active: "",
  tabs: [],
};
const noop = () => {};
export const emptyRightPanelState: RightPanelState = {
  projects: {},
  tool: noop,
  open: noop,
  collapse: noop,
  resize: noop,
  activate: noop,
  openNewTab: noop,
  openTab: noop,
  closeTab: noop,
  closeOthers: noop,
  closeAll: noop,
  moveTab: noop,
  reopenClosed: noop,
  fullViewOpen: noop,
  fullViewPatch: noop,
  fullViewExit: noop,
  setToolView: noop,
};
export function createRightPanelStore(
  storage: HostStorage,
  guard: WorkbenchNavigationGuard,
  compatibility: readonly PanelLayoutCompatibility[] = [],
) {
  let active = true;
  const store = createStore<RightPanelState>((set, get) => {
    const update = (
      project: string,
      fn: (panel: ProjectPanel) => ProjectPanel,
      isCurrent: () => boolean = () => true,
    ): void => {
      if (!active || !isCurrent()) return;
      const current = get().projects[pathKey(project)] ?? emptyPanel;
      const next = fn(current);
      const leaving =
        next.active !== current.active ||
        (current.open && !next.open) ||
        current.tabs.some(
          (tab) => !next.tabs.some((item) => item.id === tab.id),
        );
      if (leaving && !guard.guard(() => update(project, fn, isCurrent))) return;
      set((state) => {
        const key = pathKey(project);
        const projects = {
          ...state.projects,
          [key]: next,
        };
        persistPanels(storage, projects, compatibility);
        return { projects };
      });
    };
    /**
     * 通用开 tab：目标已存在→原位更新载荷并激活（占位保留）；
     * 目标不存在且激活 tab 是 new-tab 占位→原位替换（「+号打开占位、提交
     * 路径原位替换」）；否则追加到末尾。openedAt 记首次打开时间。
     */
    const openTab: RightPanelState["openTab"] = (project, tab, isCurrent) =>
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
      }, isCurrent);
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
    return {
      projects: loadPanels(storage, compatibility),
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
      tool: (project, id) => openTab(project, { id, kind: id }),
      open: (project) => update(project, (panel) => ({ ...panel, open: true })),
      collapse: (project) =>
        // 面板关闭自动退出完整视图的唯一出口：Esc / 遮罩 / ContextBar 开关全汇经此处。
        update(project, (panel) =>
          panel.fullView === undefined && !panel.open
            ? panel
            : { ...panel, open: false, fullView: undefined },
        ),
      activate: (project, id, isCurrent) =>
        update(project, (panel) => ({ ...panel, active: id, open: true }), isCurrent),
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
      openTab,
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
            // 恢复原标签引用，载荷由注册面板解释。
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
  const view = createSnapshotView(store, (state) => state);
  return {
    store: { ...store, setState },
    snapshot: view.snapshot,
    dispose() {
      active = false;
      view.dispose();
      store.setState(emptyRightPanelState, true);
    },
  };
}
