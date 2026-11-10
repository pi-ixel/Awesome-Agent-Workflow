export interface ReadonlySnapshot<State> {
  readonly getState: () => State;
  readonly getInitialState: () => State;
  readonly subscribe: (listener: (state: State, previous: State) => void) => () => void;
}

/** Project immutable source states and release all subscriptions with their owner. */
export function createSnapshotView<Source extends object, State>(
  source: ReadonlySnapshot<Source>,
  project: (state: Source) => State,
) {
  const snapshots = new WeakMap<Source, { readonly state: State }>();
  const subscriptions = new Set<() => void>();
  let disposed = false;

  function read(sourceState: Source): State {
    const cached = snapshots.get(sourceState);
    if (cached) return cached.state;
    const state = project(sourceState);
    snapshots.set(sourceState, { state });
    return state;
  }

  const snapshot: ReadonlySnapshot<State> = {
    getState: () => read(source.getState()),
    getInitialState: () => read(source.getInitialState()),
    subscribe(listener) {
      if (disposed) return () => {};
      const unsubscribe = source.subscribe((state, previous) =>
        listener(read(state), read(previous)),
      );
      subscriptions.add(unsubscribe);
      return () => {
        if (subscriptions.delete(unsubscribe)) unsubscribe();
      };
    },
  };
  return {
    snapshot,
    dispose() {
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
    },
  };
}
