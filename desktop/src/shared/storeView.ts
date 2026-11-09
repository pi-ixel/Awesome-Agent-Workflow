import { createStore, type StoreApi } from "zustand";

/** UI 只订阅当前投影；运行时始终持有独立 store，切换不会解绑其事件或轮次。 */
export function createStoreView<T>(initial: StoreApi<T>) {
  let target = initial;
  let active = true;
  const snapshot = createStore<T>(() => initial.getState());
  const publish = (state: T) => snapshot.setState(state, true);
  let unsubscribe = target.subscribe(publish);
  const view: StoreApi<T> = {
    getState: snapshot.getState,
    getInitialState: snapshot.getInitialState,
    subscribe: snapshot.subscribe,
    setState: (state, replace) => {
      if (active) target.setState(state as T, replace as true);
    },
  };
  return {
    view,
    select: (next: StoreApi<T>) => {
      if (!active || target === next) return;
      unsubscribe();
      target = next;
      unsubscribe = target.subscribe(publish);
      publish(target.getState());
    },
    dispose: () => {
      if (!active) return;
      active = false;
      unsubscribe();
      target = initial;
      publish(initial.getInitialState());
    },
  };
}
