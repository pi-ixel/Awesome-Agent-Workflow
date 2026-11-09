import type { WorkbenchUiState, RightPanelState } from "../../src/contracts/workbenchLayout.ts";
import { useStore, type StoreApi } from "zustand";
import type { WorkbenchLayout } from "../../src/contracts/workbench.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { createNavigationGuard } from "../../src/plugins/workbench/navigationGuard.ts";
import { createWorkbenchNavigation } from "../../src/plugins/workbench/navigationStore.ts";
import { createRightPanelStore } from "../../src/plugins/workbench/rightPanelStore.ts";

const navigationGuard = createNavigationGuard();
const local: WorkbenchLayout = {
  navigationGuard,
  navigation: createWorkbenchNavigation(webviewStorage, navigationGuard).store,
  panels: createRightPanelStore(webviewStorage, navigationGuard).store,
};
let bound: WorkbenchLayout | undefined;
export const readTestLayout = (): WorkbenchLayout => bound ?? local;
export function bindTestLayout(layout: WorkbenchLayout | undefined): void {
  bound = layout;
}

function testStore<T>(read: () => StoreApi<T>) {
  return Object.assign(
    <U>(select: (state: T) => U) => useStore(read(), select),
    {
      getState: () => read().getState(),
      setState: (value: Partial<T>) => read().setState(value),
      subscribe: (listener: (value: T, previous: T) => void) =>
        read().subscribe(listener),
    },
  );
}
export const useWorkbenchUiStore = testStore(
  () => readTestLayout().navigation as StoreApi<WorkbenchUiState>,
);
export const useRightPanelStore = testStore(
  () => readTestLayout().panels as StoreApi<RightPanelState>,
);

export function layoutViewFixture() {
  return {
    useWorkbenchLayout: readTestLayout,
    useWorkbenchUiValue: useWorkbenchUiStore,
    useRightPanelValue: useRightPanelStore,
  };
}
