import { useStore, type StoreApi } from "zustand";
import type { ProjectService } from "../../src/contracts/project.ts";
import type {
  WorkspaceSnapshot,
  WorkspaceStoreState,
} from "../../src/contracts/workspace.ts";
import { createHostProcessRunner } from "../../src/plugins/host/processRunner.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { createWorkspaceStore } from "../../src/plugins/project/workspaceStore.ts";
import { runWorkspaceHealthChecks } from "../../src/plugins/workflow/healthChecks.ts";
import { readTestLayout } from "./layout.ts";

export function createTestWorkspace() {
  const workspace = createWorkspaceStore(
    webviewStorage,
    createHostProcessRunner(),
    (resume, path) => readTestLayout().navigationGuard.guard(resume, path),
  );
  workspace.registerHealthCheck(runWorkspaceHealthChecks);
  return workspace.store;
}

export function mutableWorkspace(project: Pick<ProjectService, "workspace">) {
  return project.workspace as StoreApi<WorkspaceStoreState>;
}

/** Explicit workspace port for UI unit tests that mount a component in isolation. */
export function workspaceViewFixture(
  read: () => StoreApi<WorkspaceStoreState>,
) {
  return {
    useWorkspaceService: read,
    useWorkspaceValue<T>(select: (state: WorkspaceSnapshot) => T): T {
      return useStore(read(), select);
    },
  };
}
