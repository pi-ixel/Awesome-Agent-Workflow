import type { StoreApi } from "zustand";
import type {
  ProjectSessionIndexes,
  SessionCatalogState,
} from "../../src/contracts/projectSessions.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessionIndexes.ts";

export function createTestProjectIndexes() {
  const owned = createProjectSessionIndexes(webviewStorage);
  return {
    catalog: owned.catalog.store,
    activity: owned.activity,
    archive: owned.archive,
    dispose: () => owned.dispose(),
  };
}

export function mutableProjectCatalog(project: ProjectSessionIndexes) {
  return project.catalog as StoreApi<SessionCatalogState>;
}
