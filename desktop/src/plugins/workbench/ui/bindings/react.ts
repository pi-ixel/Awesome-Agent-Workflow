import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { WorkbenchContributions, WorkbenchSlot } from "../../types.ts";
import type { WorkbenchService } from "../../service.ts";
import { defaultAppearance } from "../../config.ts";

export const WorkbenchContext = createContext<WorkbenchService | null>(null);
const noSubscription = () => () => {};
const noEntries: readonly never[] = [];

export function useOpenExternal() {
  return useContext(WorkbenchContext)?.openExternal;
}

export function useWorkbenchEntries<Slot extends WorkbenchSlot>(
  slot: Slot,
): readonly WorkbenchContributions[Slot][] {
  const service = useContext(WorkbenchContext);
  const snapshot = () => service?.getSnapshot()[slot] ?? noEntries;
  return useSyncExternalStore(
    service ? (listener) => service.subscribe(listener) : noSubscription,
    snapshot,
    snapshot,
  );
}

const readDefaultAppearance = () => defaultAppearance;

export function useWorkbenchAppearance() {
  const appearance = useContext(WorkbenchContext)?.appearance;
  const read = appearance?.getSnapshot ?? readDefaultAppearance;
  const preferences = useSyncExternalStore(
    appearance?.subscribe ?? noSubscription,
    read,
    read,
  );
  return { appearance, preferences };
}

export function useWorkbenchLanguage() {
  const appearance = useContext(WorkbenchContext)?.appearance;
  const read = () => appearance?.getSnapshot().language ?? defaultAppearance.language;
  return useSyncExternalStore(appearance?.subscribe ?? noSubscription, read, read);
}

export function useWorkbenchPathOpener() {
  const workbench = useContext(WorkbenchContext);
  const resolver = useWorkbenchEntries("pathResolvers")[0];
  const openPath = useCallback<WorkbenchService["openPath"]>(
    (project, path, line, isCurrent) =>
      workbench?.openPath(project, path, line, () =>
        workbench.getSnapshot().pathResolvers[0] === resolver && (isCurrent?.() ?? true),
      ) ?? Promise.resolve(false),
    [workbench, resolver],
  );
  return resolver ? openPath : undefined;
}
