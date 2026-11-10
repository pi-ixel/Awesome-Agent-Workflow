import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GitService } from "../service.ts";
import type { ProjectGitState } from "../types.ts";
import type { ProjectWorkspace } from "../../project/service.ts";

const empty: ProjectGitState = { loading: false };
const disabledQuery = {
  getSnapshot: () => empty,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
};

export function useProjectGit(
  project: string | null,
  queryProject?: GitService["query"],
  watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"],
) {
  const query = useMemo(
    () => (project && queryProject ? queryProject(project) : disabledQuery),
    [queryProject, project],
  );
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot);
  useEffect(() => {
    if (project && query !== disabledQuery)
      return watchActivity?.(project, () => query.invalidate());
  }, [project, query, watchActivity]);
  const refresh = useCallback(async () => {
    await query.refresh();
    const error = query.getSnapshot().error;
    if (error) throw new Error(error);
  }, [query]);
  return { ...state, refresh };
}
