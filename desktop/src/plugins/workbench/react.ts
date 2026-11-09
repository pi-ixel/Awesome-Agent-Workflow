import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  WorkbenchContributions,
  WorkbenchService,
  WorkbenchSlot,
} from "../../contracts/workbench.ts";
import { defaultAppearance } from "./appearance.ts";
import type { SessionSnapshot } from "../../contracts/projectSessions.ts";

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

const noIdentity = () => null;
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

export function useWorkbenchGit() {
  return useWorkbenchEntries("gitReview")[0]?.service;
}

export function useWorkbenchAgents() {
  return useWorkbenchEntries("agents")[0]?.service;
}

export function useWorkbenchDocuments() {
  return useWorkbenchEntries("documents")[0]?.service;
}

export function useWorkbenchProject() {
  return useWorkbenchEntries("project")[0]?.service;
}

/** Registered state can disappear when its owning Fiber is unloaded. */
export function useRegisteredSnapshot<State, Selected>(
  store: SessionSnapshot<State> | undefined,
  select: (state: State | undefined) => Selected,
): Selected {
  const read = () => select(store?.getState());
  return useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);
}

export function useWorkbenchAgentConfiguration() {
  const agents = useWorkbenchAgents();
  const state = agents?.configuration;
  const read = state?.getState ?? noIdentity;
  const configuration = useSyncExternalStore(
    state?.subscribe ?? noSubscription,
    read,
    read,
  );
  return { agents, configuration };
}

export function useWorkbenchSkills() {
  return useWorkbenchEntries("skills")[0]?.service;
}

export function useWorkbenchIdentity() {
  const identity = useWorkbenchEntries("accountIdentity")[0];
  const snapshot = identity?.getSnapshot ?? noIdentity;
  return useSyncExternalStore(
    identity?.subscribe ?? noSubscription,
    snapshot,
    snapshot,
  );
}

export function useWorkbenchAction(id: string): (() => void) | undefined {
  return useWorkbenchEntries("actions").find((action) => action.id === id)?.run;
}
