import { createStore } from "zustand";
import type { SessionStatusViewState } from "../types.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

/** Project 内的会话共享展示偏好，重装时恢复自动。 */
export function createSessionStatusView() {
  let active = true;
  const store = createStore<SessionStatusViewState>(() => ({ mode: "auto" }));
  const view = createSnapshotView(store, (state) => state);
  return {
    view: view.snapshot,
    setMode: (mode: SessionStatusViewState["mode"]) => {
      if (active) store.setState({ mode });
    },
    dispose() {
      active = false;
      store.setState({ mode: "auto" });
      view.dispose();
    },
  };
}
