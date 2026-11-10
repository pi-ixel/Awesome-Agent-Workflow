import type { HostStorage } from "../../host/types.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createSessionCatalog } from "./catalog.ts";
import { createSessionActivityStore } from "./sessionActivityStore.ts";
import { createSessionArchiveStore } from "./sessionArchiveStore.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export function createProjectSessionIndexes(storage: HostStorage, logger?: Logger) {
  const scope = new AbortController();
  const catalog = createSessionCatalog(scope.signal);
  const activity = createSessionActivityStore(scope.signal);
  const archive = createSessionArchiveStore(
    storage,
    catalog.store.getState,
    scope.signal,
    logger,
  );
  const catalogView = createSnapshotView(catalog.store, (state) => state);
  const activityView = createSnapshotView(activity, ({ entries }) => ({ entries }));
  const archiveView = createSnapshotView(archive, ({ notice, archivedSessions, metadata }) => ({
    notice,
    archivedSessions,
    metadata,
  }));
  return {
    catalog,
    activity,
    archive,
    catalogView: catalogView.snapshot,
    activityView: activityView.snapshot,
    archiveView: archiveView.snapshot,
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
      catalogView.dispose();
      activityView.dispose();
      archiveView.dispose();
    },
  };
}
