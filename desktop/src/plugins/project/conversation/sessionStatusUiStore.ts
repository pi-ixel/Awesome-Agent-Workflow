import { createStore } from "zustand";
import type { SessionStatusViewState } from "../../../contracts/project.ts";

/** Project 内的会话共享展示偏好，重装时恢复自动。 */
export function createSessionStatusView() {
  let active = true;
  const store = createStore<SessionStatusViewState>((set) => ({
    mode: "auto",
    setMode: (mode) => {
      if (active) set({ mode });
    },
  }));
  return {
    store,
    dispose() {
      active = false;
      store.setState({ mode: "auto" });
    },
  };
}
