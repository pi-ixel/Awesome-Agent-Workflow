import type { HostStorage } from "../../contracts/host.ts";
import { createSessionCatalog } from "./catalog.ts";
import { createSessionActivityStore } from "./sessionActivityStore.ts";
import { createSessionArchiveStore } from "./sessionArchiveStore.ts";

export function createProjectSessionIndexes(storage: HostStorage) {
  const scope = new AbortController();
  const catalog = createSessionCatalog(scope.signal);
  const activity = createSessionActivityStore(scope.signal);
  const archive = createSessionArchiveStore(
    storage,
    catalog.store.getState,
    scope.signal,
  );
  return {
    catalog,
    activity,
    archive,
    dispose() {
      if (scope.signal.aborted) return;
      scope.abort();
      catalog.resetCatalog();
      activity.getState().reset();
      archive.setState({
        notice: null,
        archivedSessions: new Set(),
        metadata: {},
      });
    },
  };
}
