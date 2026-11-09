import { useStore, type StoreApi } from "zustand";
import type { ProjectService } from "../../src/contracts/project.ts";
import type { createProjectForeground, ProjectForegroundStores } from "../../src/plugins/project/conversation/foreground.ts";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import { createApprovalStore } from "../../src/plugins/project/interactions/approvalStore.ts";
import { createRuntimeStatusStore } from "../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { createStoreView } from "../../src/shared/storeView.ts";

const session = createStoreView(createSessionStore());
const approval = createStoreView(createApprovalStore());
const runtime = createStoreView(createRuntimeStatusStore());
const isolated = {
  session: session.view,
  approval: approval.view,
  runtime: runtime.view,
};
type ForegroundOwner = ReturnType<typeof createProjectForeground>;
let bound: ForegroundOwner | undefined;

export function bindForeground(owner: ForegroundOwner) {
  bound = owner;
}

export function mutableProjectForeground(project: Pick<ProjectService, "foreground">) {
  return project.foreground as ProjectForegroundStores;
}

function testStore<T>(read: () => StoreApi<T>) {
  return Object.assign(
    <Selected>(select: (state: T) => Selected) => useStore(read(), select),
    {
      getState: () => read().getState(),
      getInitialState: () => read().getInitialState(),
      subscribe: (listener: Parameters<StoreApi<T>["subscribe"]>[0]) =>
        read().subscribe(listener),
      setState: (state: T | Partial<T> | ((state: T) => T | Partial<T>)) =>
        read().setState(state),
    },
  );
}

export const useSessionStore = testStore(
  () => bound?.view.session ?? isolated.session,
);
export const useApprovalStore = testStore(
  () => bound?.view.approval ?? isolated.approval,
);
export const useRuntimeStatusStore = testStore(
  () => bound?.view.runtime ?? isolated.runtime,
);
export const selectSessionStore = session.select;
export const selectRuntimeStatusStore = runtime.select;

export const foregroundFixture: ForegroundOwner = {
  get activity() {
    if (!bound) throw new Error("Test coordinator foreground is not bound");
    return bound.activity;
  },
  view: {
    session: useSessionStore,
    approval: useApprovalStore,
    runtime: useRuntimeStatusStore,
  },
  select(...args) {
    if (!bound) throw new Error("Test coordinator foreground is not bound");
    bound.select(...args);
  },
  dispose() {
    bound = undefined;
  },
};

export function conversationViewFixture() {
  return {
    useConversation: () => foregroundFixture.view,
    useSessionValue: useSessionStore,
    useApprovalValue: useApprovalStore,
    useRuntimeValue: useRuntimeStatusStore,
  };
}
