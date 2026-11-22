import type { GitService } from "../../src/plugins/git/service.ts";
import { GitPanel } from "../../src/plugins/git/ui/GitPanel.tsx";
import { GitDiffView } from "../../src/plugins/git/ui/GitDiffView.tsx";
import type { GitSnapshot } from "../../src/plugins/host/types.ts";

const path = "src/whats-new-and-migration-notes-for-this-release.md";
const project = "/project";
const snapshot: GitSnapshot = {
  repoRoot: project,
  branch: "main",
  upstream: null,
  watchPaths: [],
  branchChanges: [],
  changes: [
    {
      path,
      oldPath: null,
      source: "unstaged",
      status: "修改",
      added: 3,
      removed: 1,
    },
    {
      path: "draft.md",
      oldPath: null,
      source: "untracked",
      status: "新增",
      added: 1,
      removed: 0,
    },
  ],
};
const state = { data: snapshot, loading: false };
const query = {
  getSnapshot: () => state,
  refresh: () => Promise.resolve(),
  invalidate: () => {},
  subscribe: () => () => {},
};
const git: GitService = {
  query: () => query,
  reviewRailWidth: 240,
  setReviewRailWidth: () => {},
  status: () => Promise.resolve(snapshot),
  diff: () =>
    Promise.resolve({
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      notice: null,
      beforeContent: "old\n",
      afterContent: "new\n",
    }),
};

export function GitNavigationFixture({
  unified = false,
}: {
  unified?: boolean;
}) {
  return (
    <section
      aria-label="Git 文件导航示例"
      className="h-96 overflow-hidden rounded-xl border border-line"
    >
      {unified ? (
        <GitDiffView
          project={project}
          gitService={git}
          change={snapshot.changes[0]!}
          repoRoot={project}
          onFile={() => {}}
        />
      ) : (
        <GitPanel project={project} git={git} />
      )}
    </section>
  );
}
