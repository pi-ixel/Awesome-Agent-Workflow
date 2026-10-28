import { create, type StoreApi } from "zustand";

/** UI 只订阅当前投影；运行时始终持有独立 store，切换不会解绑其事件或轮次。 */
export function createStoreView<T>(initial: StoreApi<T>) {
  let target = initial;
  const view = create<T>(() => target.getState());
  const publish = view.setState;
  let unsubscribe = target.subscribe((state) => publish(state, true));
  view.setState = (state, replace) =>
    target.setState(state as T, replace as true);
  return {
    view,
    select: (next: StoreApi<T>) => {
      if (target === next) return;
      unsubscribe();
      target = next;
      publish(target.getState(), true);
      unsubscribe = target.subscribe((state) => publish(state, true));
    },
  };
}
