import { useSyncExternalStore } from "react";
import type { ReadonlySnapshot } from "./readonlySnapshot.ts";

const noSubscription = () => () => {};

/** Registered state can disappear when its owning Fiber is unloaded. */
export function useRegisteredSnapshot<State, Selected>(
  store: ReadonlySnapshot<State> | undefined,
  select: (state: State | undefined) => Selected,
): Selected {
  const read = () => select(store?.getState());
  return useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);
}
