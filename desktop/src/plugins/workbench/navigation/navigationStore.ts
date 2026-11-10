import type { WorkbenchUiState } from "../layout/types.ts";
import type { HostStorage } from "../../host/types.ts";
import type { WorkbenchNavigationGuard } from "../types.ts";
/** Workbench content navigation and shell layout preferences. */
import { createStore, type StoreApi } from "zustand";

import { createLogger } from "../../../shared/logging/logger.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

/** 侧边栏收起态的持久化键。 */
const SIDEBAR_COLLAPSED_KEY = "aaw-desktop/layout/sidebar-collapsed";
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

const noop = () => {};
export const emptyWorkbenchUi: WorkbenchUiState = {
  viewId: null,
  contextPath: null,
  overlay: null,
  settingsInitialTab: "general",
  sidebarCollapsed: false,
  openDock: null,
  openSettingsTab: noop,
  openView: noop,
  restoreContextView: noop,
  toggleDock: noop,
  closeDock: noop,
  toggleOverlay: noop,
  closeOverlay: noop,
  clearContextIf: noop,
  toggleSidebarCollapsed: noop,
};

export function createWorkbenchNavigation(
  storage: HostStorage,
  guard: WorkbenchNavigationGuard,
  logger = createLogger("ui"),
) {
  let active = true;
  const viewOpened = new Set<() => void>();
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
      openSettingsTab: (tab, isCurrent = () => true) => {
        if (!active || !isCurrent()) return;
        if (!guard.guard(() => get().openSettingsTab(tab, isCurrent))) return;
        set({ overlay: "settings", settingsInitialTab: tab });
      },

      openView: (id, path, isCurrent = () => true) => {
        if (!active || !isCurrent()) return;
        if (
          pathKey(get().contextPath ?? "") !== pathKey(path ?? "") &&
          !guard.guard(() => get().openView(id, path, isCurrent))
        )
          return;
        set({
          viewId: id,
          contextPath: path,
          overlay: null,
        });
        logger.debug("内容区打开页面", { id, path });
        for (const listener of viewOpened) listener();
      },

      restoreContextView: (view) => {
        if (
          pathKey(get().contextPath ?? "") !==
            pathKey(view.contextPath ?? "") &&
          !guard.guard(() => get().restoreContextView(view))
        )
          return;
        set({
          viewId: view.viewId,
          contextPath: view.contextPath,
        });
        logger.debug("内容区回滚到点击前的视图", {
          id: view.viewId,
          path: view.contextPath,
        });
      },

      toggleDock: (id) => {
        const open = get().openDock !== id;
        set({ openDock: open ? id : null });
        logger.debug("底部面板切换", { id, open });
      },
      closeDock: (id) => {
        if (get().openDock === id) get().toggleDock(id);
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

      clearContextIf: (path, isCurrent = () => true) => {
        const current = get().contextPath;
        if (!isCurrent() || current === null || pathKey(current) !== pathKey(path)) return;
        if (!guard.guard(() => get().clearContextIf(path, isCurrent), path)) return;
        set({
          viewId: null,
          contextPath: null,
        });
        logger.debug("内容区已清除当前上下文", { path });
      },

      toggleSidebarCollapsed: () => {
        const next = !get().sidebarCollapsed;
        set({ sidebarCollapsed: next });
        if (active) writePref(storage, SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
        logger.debug("侧边栏收起态切换", { collapsed: next });
      },

    };
  });
  const setState: StoreApi<WorkbenchUiState>["setState"] = (state, replace) => {
    if (active) store.setState(state as WorkbenchUiState, replace as true);
  };
  const view = createSnapshotView(store, (state) => state);
  return {
    store: { ...store, setState },
    snapshot: view.snapshot,
    onViewOpened(listener: () => void) {
      if (active) viewOpened.add(listener);
      return () => { viewOpened.delete(listener); };
    },
    dispose() {
      active = false;
      viewOpened.clear();
      view.dispose();
      store.setState(emptyWorkbenchUi, true);
    },
  };
}
