import { insidePath } from "../../../shared/panelPaths.ts";
import type { ProjectForeground } from "../conversation/viewState.ts";
import type { ConversationValues } from "../conversation/types.ts";
import type { WorkspaceView } from "./types.ts";

function marker(state: ConversationValues): string {
  let completed = 0;
  for (const item of state.items)
    if (
      item.kind === "tool" &&
      (item.status === "completed" || item.status === "failed")
    )
      completed++;
  return `${state.activeSessionId}:${state.isAgentRunning}:${completed}`;
}

/** Debounce foreground activity for UI consumers of the current workspace. */
export function createWorkspaceActivity(
  workspace: WorkspaceView,
  session: ProjectForeground["session"],
) {
  const subscriptions = new Set<() => void>();
  let disposed = false;

  function subscribe(path: string, listener: () => void): () => void {
    if (disposed) return () => {};
    let activePath = workspace.getState().activePath;
    let previousMarker = marker(session.getState());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (activePath && insidePath(activePath, path))
        timer = setTimeout(listener, 400);
    };
    const stopWorkspace = workspace.subscribe((state) => {
      if (state.activePath === activePath) return;
      activePath = state.activePath;
      schedule();
    });
    const stopSession = session.subscribe((state, previous) => {
      if (
        state.items === previous.items &&
        state.activeSessionId === previous.activeSessionId &&
        state.isAgentRunning === previous.isAgentRunning
      )
        return;
      const nextMarker = marker(state);
      if (nextMarker === previousMarker) return;
      previousMarker = nextMarker;
      schedule();
    });
    const release = () => {
      if (!subscriptions.delete(release)) return;
      clearTimeout(timer);
      stopWorkspace();
      stopSession();
    };
    subscriptions.add(release);
    schedule();
    return release;
  }

  return {
    subscribe,
    dispose() {
      disposed = true;
      for (const release of subscriptions) release();
    },
  };
}
