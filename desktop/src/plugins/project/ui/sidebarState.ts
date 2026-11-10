import { createStore } from "zustand";
import type { HostStorage } from "../../host/types.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { projectSidebarViewKey } from "../config.ts";

export const SESSION_LIST_PAGE_SIZE = 5;
type TreeViewMode = "projects" | "sessions";

export interface ProjectSidebarState {
  readonly treeViewMode: TreeViewMode;
  readonly expandedOverrides: Readonly<Record<string, boolean>>;
  readonly sessionListLimits: Readonly<Record<string, number>>;
  readonly isAddPanelOpen: boolean;
  readonly setTreeViewMode: (mode: TreeViewMode) => void;
  readonly toggleExpanded: (path: string, isExpandedNow?: boolean) => void;
  readonly expandSessionList: (path: string) => void;
  readonly toggleAddPanel: () => void;
  readonly closeAddPanel: () => void;
}

const noop = () => {};
export const emptyProjectSidebar: ProjectSidebarState = {
  treeViewMode: "projects",
  expandedOverrides: {},
  sessionListLimits: {},
  isAddPanelOpen: false,
  setTreeViewMode: noop,
  toggleExpanded: noop,
  expandSessionList: noop,
  toggleAddPanel: noop,
  closeAddPanel: noop,
};

function restoreMode(storage: HostStorage): TreeViewMode {
  try {
    return storage.getItem(projectSidebarViewKey) === "sessions"
      ? "sessions"
      : "projects";
  } catch {
    return "projects";
  }
}

export function createProjectSidebarState(storage: HostStorage) {
  let active = true;
  const store = createStore<ProjectSidebarState>((set, get) => ({
    ...emptyProjectSidebar,
    treeViewMode: restoreMode(storage),
    setTreeViewMode(mode) {
      if (!active) return;
      try {
        storage.setItem(projectSidebarViewKey, mode);
      } catch {
        // The current UI can still switch views if preference storage fails.
      }
      set({ treeViewMode: mode });
    },
    toggleExpanded(path, isExpandedNow) {
      if (!active) return;
      const overrides = get().expandedOverrides;
      set({
        expandedOverrides: {
          ...overrides,
          [path]: !(isExpandedNow ?? overrides[path] ?? true),
        },
      });
    },
    expandSessionList(path) {
      if (!active) return;
      const limits = get().sessionListLimits;
      set({
        sessionListLimits: {
          ...limits,
          [path]:
            (limits[path] ?? SESSION_LIST_PAGE_SIZE) + SESSION_LIST_PAGE_SIZE,
        },
      });
    },
    toggleAddPanel() {
      if (!active) return;
      if (get().treeViewMode !== "projects") get().setTreeViewMode("projects");
      set({ isAddPanelOpen: !get().isAddPanelOpen });
    },
    closeAddPanel() {
      if (active && get().isAddPanelOpen) set({ isAddPanelOpen: false });
    },
  }));
  const view = createSnapshotView(store, (state) => state);
  return {
    store,
    snapshot: view.snapshot,
    dispose() {
      active = false;
      view.dispose();
      store.setState(emptyProjectSidebar, true);
    },
  };
}
