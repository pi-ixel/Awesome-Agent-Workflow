import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useWorkbenchGit } from "../../react.ts";
import { useAgentRevision } from "./useAgentRevision.ts";
import type { GitService, ProjectGitState } from "../../../../contracts/git.ts";

const empty: ProjectGitState = { loading: false };
const disabledQuery = {
  getSnapshot: () => empty,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
};

export function useProjectGit(
  project: string | null,
  source?: Pick<GitService, "query">,
) {
  const registered = useWorkbenchGit();
  const git = source ?? registered;
  const query = useMemo(
    () => (project && git ? git.query(project) : disabledQuery),
    [git, project],
  );
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot);
  const revision = useAgentRevision(project ?? "", query !== disabledQuery);
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
