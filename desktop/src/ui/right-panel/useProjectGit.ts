import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { getProjectGitQuery } from "../../core/projectGitQuery.ts";
import { useAgentRevision } from "./useAgentRevision.ts";
import type { ProjectGitState } from "../../core/projectGitQuery.ts";

const empty: ProjectGitState = { loading: false };
const disabledQuery = {
  getSnapshot: () => empty,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
};

export function useProjectGit(project: string | null) {
  const query = useMemo(
    () => (project ? getProjectGitQuery(project) : disabledQuery),
    [project],
  );
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot);
  const revision = useAgentRevision(project ?? "", project !== null);
  useEffect(() => {
    if (revision > 0) query.invalidate();
  }, [query, revision]);
  const refresh = useCallback(async () => {
    await query.refresh();
    const error = query.getSnapshot().error;
    if (error) throw new Error(error);
  }, [query]);
  return { ...state, refresh };
}
