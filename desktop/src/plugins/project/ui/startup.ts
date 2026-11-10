import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { StartupWait } from "../../workbench/types.ts";
import type { SessionCatalogState, WorkspaceView } from "../types.ts";
import { knownWorkspacePaths } from "../workspace/knownPaths.ts";

export const STARTUP_MAX_WAIT_MS = 8_000;

interface StartupSources {
  readonly workspace: WorkspaceView;
  readonly catalog: ReadonlySnapshot<SessionCatalogState>;
  readonly selection?: ReadonlySnapshot<{ readonly activeAgentId: string }>;
}

/** Only the initial paths participate. Background preloading lives in Project's Fiber. */
export function captureProjectStartup({
  workspace,
  catalog,
  selection,
}: StartupSources): StartupWait | undefined {
  const paths = knownWorkspacePaths(workspace.getState()).map(pathKey);
  if (!paths.length) return;
  const agentId = selection?.getState().activeAgentId;
  return {
    timeoutMs: STARTUP_MAX_WAIT_MS,
    isReady: () => {
      const { agentKey, statusByPath } = catalog.getState();
      return selection?.getState().activeAgentId !== agentId ||
        (agentKey !== null && paths.every((path) => {
          const status = statusByPath[path];
          return status !== undefined && status.state !== "loading";
        }));
    },
    subscribe: (check) => {
      const stopCatalog = catalog.subscribe(check);
      const stopSelection = selection?.subscribe(check);
      return () => {
        stopCatalog();
        stopSelection?.();
      };
    },
  };
}
