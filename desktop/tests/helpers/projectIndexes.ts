import type { StoreApi } from "zustand";
import { vi } from "vitest";
import type { ProjectSessions } from "../../src/plugins/project/service.ts";
import type { SessionCatalogState } from "../../src/plugins/project/types.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";

const catalogOwners = vi.hoisted(
  () => new WeakMap<ProjectSessions["catalog"], StoreApi<SessionCatalogState>>(),
);
vi.mock(import("../../src/plugins/project/sessions/sessionIndexes.ts"), async (original) => {
  const module = await original();
  return {
    ...module,
    createProjectSessionIndexes(...args: Parameters<typeof module.createProjectSessionIndexes>) {
      const owner = module.createProjectSessionIndexes(...args);
      catalogOwners.set(owner.catalogView, owner.catalog.store);
      return owner;
    },
  };
});

export function createTestProjectIndexes() {
  const owned = createProjectSessionIndexes(webviewStorage);
  const { dismissNotice, archiveWithNotice, unarchiveSession } = owned.archive.getState();
  return {
    catalog: owned.catalog.store,
    activity: owned.activity,
    archive: owned.archive,
    dismissArchiveNotice: dismissNotice,
    archiveWithNotice,
    unarchiveSession,
    dispose: () => owned.dispose(),
  };
}

export function mutableProjectCatalog(project: Pick<ProjectSessions, "catalog">) {
  const catalog = catalogOwners.get(project.catalog);
  if (!catalog) throw new Error("Missing Project session catalog test owner");
  return catalog;
}
