import { createStore } from "zustand";
import type { HostStorage } from "../../../host/types.ts";
import { createSnapshotView } from "../../../../shared/state/readonlySnapshot.ts";
import { timelineCollapsedStorageKey } from "../../config.ts";

function readExpanded(storage: HostStorage): boolean {
  try {
    return storage.getItem(timelineCollapsedStorageKey) === "0";
  } catch {
    return false;
  }
}

export function createTimelineDrawer(storage: HostStorage) {
  const store = createStore(() => ({ expanded: readExpanded(storage) }));
  const view = createSnapshotView(store, (state) => state.expanded);
  let active = true;

  function setExpanded(expanded: boolean): void {
    if (!active || store.getState().expanded === expanded) return;
    try {
      storage.setItem(timelineCollapsedStorageKey, expanded ? "0" : "1");
    } catch {
      // Keep the current view usable when preference storage is unavailable.
    }
    store.setState({ expanded });
  }

  return {
    state: view.snapshot,
    isExpanded: () => active && store.getState().expanded,
    toggle: () => setExpanded(!store.getState().expanded),
    close: () => setExpanded(false),
    dispose() {
      active = false;
      view.dispose();
      store.setState({ expanded: false });
    },
  };
}
