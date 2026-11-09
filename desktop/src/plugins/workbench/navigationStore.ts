import type { TreeViewMode, WorkbenchUiState } from "../../contracts/workbenchLayout.ts";
import { SESSION_LIST_PAGE_SIZE } from "../../contracts/workbenchLayout.ts";
import type { HostStorage } from "../../contracts/host.ts";
import type { WorkbenchNavigationGuard } from "../../contracts/workbench.ts";
/**
 * 工作台界面状态 store：内容区视图、左栏树的展开态
 * 与侧边栏布局偏好（纯 UI 状态，不持业务数据——项目与会话数据仍在各自
 * 的 store）。
 *
 * 视图模型（树状视图 + 内容区布局）：
 * - 基底视图 treeView 由左栏树的选中项驱动（项目总览 / 会话），
 *   contextPath 是选中项所属的项目路径（两个视图共用的项目上下文）；
 * - 「设置 / 诊断」是功能页覆盖层 overlay，自侧栏底部 SidebarFooter 的
 *   入口激活后呈**全屏**语义：侧边栏树列与顶栏按钮组隐藏，内容区只
 *   渲染该页 + 上下文条「← 返回」；再点同页入口（或返回按钮）取消
 *   覆盖，点树节点同样清除；
 * - 树的展开态只记「用户显式切换」的覆盖值：未出现的项目按默认规则
 *   （有会话子节点的展开）渲染，规则本身由组件计算，store 不复刻数据源；
 * - 侧边栏收起态 sidebarCollapsed 表示「隐藏 / 显示树列」（收起后开关
 *   移入顶栏左端 / 树列顶部拖拽带，无第二条窄条）与树的视角
 *   treeViewMode 是布局偏好，变更即持久化到 localStorage（键见下方常量），
 *   实例创建时恢复；【+】弹出面板与底部终端面板是纯会话内
 *   状态，不持久化（终端默认关闭，对齐 ZCode useAppPanels 的缺省）。
 */
import { createStore, type StoreApi } from "zustand";

import { createLogger } from "../../shared/diagnosticEvents/logger.ts";
import { pathKey } from "../../shared/panelPaths.ts";

/** 侧边栏收起态的持久化键。 */
const SIDEBAR_COLLAPSED_KEY = "aaw-desktop/layout/sidebar-collapsed";
/** 侧边栏视角的持久化键。 */
const TREE_VIEW_MODE_KEY = "aaw-desktop/sidebar/view";

/** 流程时间线收起态的持久化键。 */
const TIMELINE_COLLAPSED_KEY = "aaw-desktop/layout/timeline-collapsed";

/** 读持久化字符串（缺失 / 环境不支持返回 null）。 */
function readPref(storage: HostStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** 写持久化字符串（失败不阻断——布局偏好丢得起）。 */
function writePref(storage: HostStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // 持久化失败不影响本次会话内的布局
  }
}

/** 从持久化恢复收起态（"1" 为收起；缺失 / 损坏按展开处理）。 */
function restoreSidebarCollapsed(storage: HostStorage): boolean {
  return readPref(storage, SIDEBAR_COLLAPSED_KEY) === "1";
}

/** 从持久化恢复视角（仅接受 "sessions"；其余按项目视角处理）。 */
function restoreTreeViewMode(storage: HostStorage): TreeViewMode {
  return readPref(storage, TREE_VIEW_MODE_KEY) === "sessions"
    ? "sessions"
    : "projects";
}

/** 从持久化恢复时间线收起态（"1" 为收起；缺失按展开处理）。 */
function restoreTimelineCollapsed(storage: HostStorage): boolean {
  // 默认收起（紧凑进度条是常态，全图抽屉按需展开）；显式展开过（"0"）
  // 的老偏好保持展开
  return readPref(storage, TIMELINE_COLLAPSED_KEY) !== "0";
}

const logger = createLogger("ui");

/** 会话子节点每项目的默认呈现条数，也是「加载更多」的步长。 */

const noop = () => {};
export const emptyWorkbenchUi: WorkbenchUiState = {
  treeView: "project-overview",
  contextPath: null,
  overlay: null,
  settingsInitialTab: "general",
  expandedOverrides: {},
  sessionListLimits: {},
  sidebarCollapsed: false,
  treeViewMode: "projects",
  isTimelineCollapsed: true,
  isTerminalOpen: false,
  isAddPanelOpen: false,
  openSettingsTab: noop,
  openProjectOverview: noop,
  openSessionView: noop,
  restoreContextView: noop,
  toggleTimeline: noop,
  toggleTerminal: noop,
  toggleOverlay: noop,
  closeOverlay: noop,
  toggleExpanded: noop,
  clearContextIf: noop,
  toggleSidebarCollapsed: noop,
  setTreeViewMode: noop,
  toggleAddPanel: noop,
  closeAddPanel: noop,
  expandSessionList: noop,
};

export function createWorkbenchNavigation(
  storage: HostStorage,
  guard: WorkbenchNavigationGuard,
) {
  let active = true;
  const store = createStore<WorkbenchUiState>((update, get) => {
    const set = (
      patch:
        | Partial<WorkbenchUiState>
        | ((state: WorkbenchUiState) => Partial<WorkbenchUiState>),
    ) => {
      if (active) update(patch);
    };
    return {
      ...emptyWorkbenchUi,
      sidebarCollapsed: restoreSidebarCollapsed(storage),
      treeViewMode: restoreTreeViewMode(storage),
      isTimelineCollapsed: restoreTimelineCollapsed(storage),
      openSettingsTab: (tab) => {
        if (!guard.guard(() => get().openSettingsTab(tab))) return;
        set({ overlay: "settings", settingsInitialTab: tab });
      },

      openProjectOverview: (path) => {
        if (
          pathKey(get().contextPath ?? "") !== pathKey(path) &&
          !guard.guard(() => get().openProjectOverview(path))
        )
          return;
        set({
          treeView: "project-overview",
          contextPath: path,
          overlay: null,
          isAddPanelOpen: false,
        });
        logger.debug("内容区切换到项目总览", { path });
      },

      openSessionView: (path) => {
        if (
          pathKey(get().contextPath ?? "") !== pathKey(path) &&
          !guard.guard(() => get().openSessionView(path))
        )
          return;
        set({
          treeView: "session",
          contextPath: path,
          overlay: null,
          isAddPanelOpen: false,
        });
        logger.debug("内容区切换到会话视图", { path });
      },

      restoreContextView: (view) => {
        if (
          pathKey(get().contextPath ?? "") !==
            pathKey(view.contextPath ?? "") &&
          !guard.guard(() => get().restoreContextView(view))
        )
          return;
        set({
          treeView: view.treeView,
          contextPath: view.contextPath,
        });
        logger.debug("内容区回滚到点击前的视图", view);
      },

      toggleTimeline: () => {
        const next = !get().isTimelineCollapsed;
        set({ isTimelineCollapsed: next });
        if (active)
          writePref(storage, TIMELINE_COLLAPSED_KEY, next ? "1" : "0");
      },

      toggleTerminal: () => {
        const next = !get().isTerminalOpen;
        set({ isTerminalOpen: next });
        logger.debug("底部终端面板切换", { open: next });
      },

      toggleOverlay: (view) => {
        if (!guard.guard(() => get().toggleOverlay(view))) return;
        const next = get().overlay === view ? null : view;
        set(
          next === "settings"
            ? { overlay: next, settingsInitialTab: "general" }
            : { overlay: next },
        );
        logger.debug("功能页覆盖层切换", { view, open: next !== null });
      },

      closeOverlay: () => {
        if (get().overlay === null) {
          return;
        }
        set({ overlay: null });
        logger.debug("功能页覆盖层已关闭（返回树选中视图）");
      },

      toggleExpanded: (path, isExpandedNow = null) => {
        set((state) => {
          const current = state.expandedOverrides[path] ?? null;
          // 组件把「现在是不是展开的」传进来时，覆盖值即它的反面（精确）；
          // 未传时退回旧语义——以「默认展开（有会话）」的反面为目标。
          const next =
            isExpandedNow === null
              ? current === null
                ? false
                : !current
              : !isExpandedNow;
          return {
            expandedOverrides: { ...state.expandedOverrides, [path]: next },
          };
        });
      },

      clearContextIf: (path) => {
        if (!guard.guard(() => get().clearContextIf(path))) return;
        if (get().contextPath !== path) {
          return;
        }
        set({
          treeView: "project-overview",
          contextPath: null,
        });
        logger.debug("项目已移出列表，内容区回落空态", { path });
      },

      toggleSidebarCollapsed: () => {
        const next = !get().sidebarCollapsed;
        set({ sidebarCollapsed: next });
        if (active) writePref(storage, SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
        logger.debug("侧边栏收起态切换", { collapsed: next });
      },

      setTreeViewMode: (mode) => {
        set({ treeViewMode: mode });
        if (active) writePref(storage, TREE_VIEW_MODE_KEY, mode);
        logger.debug("侧边栏视角切换", { mode });
      },

      toggleAddPanel: () => {
        const next = !get().isAddPanelOpen;
        set({ isAddPanelOpen: next });
        logger.debug("【+】弹出面板切换", { open: next });
      },

      closeAddPanel: () => {
        if (!get().isAddPanelOpen) {
          return;
        }
        set({ isAddPanelOpen: false });
      },

      expandSessionList: (path) => {
        const { sessionListLimits } = get();
        const current = sessionListLimits[path] ?? SESSION_LIST_PAGE_SIZE;
        set({
          sessionListLimits: {
            ...sessionListLimits,
            [path]: current + SESSION_LIST_PAGE_SIZE,
          },
        });
      },
    };
  });
  const setState: StoreApi<WorkbenchUiState>["setState"] = (state, replace) => {
    if (active) store.setState(state as WorkbenchUiState, replace as true);
  };
  return {
    store: { ...store, setState },
    dispose() {
      active = false;
      store.setState(emptyWorkbenchUi, true);
    },
  };
}
