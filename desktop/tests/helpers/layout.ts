import { useStore, type StoreApi } from "zustand";
import { workbenchOwner } from "./workbenchOwner.ts";
import type { WorkbenchLayout } from "../../src/plugins/workbench/types.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { createNavigationGuard } from "../../src/plugins/workbench/navigation/navigationGuard.ts";
import { createWorkbenchNavigation } from "../../src/plugins/workbench/navigation/navigationStore.ts";
import { createRightPanelStore } from "../../src/plugins/workbench/layout/rightPanelStore.ts";
import { projectPageOf, type ProjectPage } from "../../src/plugins/project/ui/bindings/projectPage.ts";
import { createSnapshotView } from "../../src/shared/state/readonlySnapshot.ts";
import { desktopPanelLayouts } from "../../src/bootstrap/panelLayouts.ts";
import { restorePanels } from "../../src/plugins/workbench/layout/panelStorage.ts";

const navigationGuard = createNavigationGuard();
const local = {
  navigationGuard,
  navigation: createWorkbenchNavigation(webviewStorage, navigationGuard).store,
  panels: createRightPanelStore(webviewStorage, navigationGuard, desktopPanelLayouts).store,
};
export const restoreDesktopPanels = (raw: string | null) => restorePanels(raw, desktopPanelLayouts);
let bound: ReturnType<typeof workbenchOwner> | undefined;
export const readTestLayout = (): WorkbenchLayout => bound?.service ?? local;
export function bindTestLayout(layout: WorkbenchLayout | undefined): void {
  bound = layout && workbenchOwner(layout);
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
  () => bound?.["navigationOwner"].store ?? local.navigation,
);
export const useRightPanelStore = testStore(
  () => bound?.["panelsOwner"].store ?? local.panels,
);

export function layoutViewFixture() {
  return {
    useWorkbenchLayout: readTestLayout,
    useWorkbenchUiValue: useWorkbenchUiStore,
    useRightPanelValue: useRightPanelStore,
  };
}

export function projectPageFixture() {
  const { snapshot } = createSnapshotView(readTestLayout().navigation, projectPageOf);
  return {
    useProjectPage: () => snapshot,
    useProjectPageValue: <T>(select: (page: ProjectPage) => T) =>
      useWorkbenchUiStore((state) => select(projectPageOf(state))),
  };
}
