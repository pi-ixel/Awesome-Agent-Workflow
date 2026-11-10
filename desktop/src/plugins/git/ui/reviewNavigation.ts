import { createStore } from "zustand";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import type { WorkbenchLayout } from "../../workbench/types.ts";
import type { GitReviewNavigation } from "../types.ts";

export interface GitReviewReveal {
  readonly source: "changes" | "untracked";
  readonly revision: number;
}

export function createGitReviewNavigation(layout: Pick<WorkbenchLayout, "panels">) {
  const requests = createStore<Readonly<Record<string, GitReviewReveal>>>(() => ({}));
  const view = createSnapshotView(requests, (state) => state);
  let sequence = 0;
  let disposed = false;
  const navigation: GitReviewNavigation = {
    open(project, source) {
      if (disposed) return;
      requests.setState({ [pathKey(project)]: { source, revision: ++sequence } });
      layout.panels.getState().openTab(project, { id: "git", kind: "git" }, () => !disposed);
    },
  };
  return {
    navigation,
    requests: view.snapshot,
    dispose() {
      disposed = true;
      view.dispose();
      requests.setState({}, true);
    },
  };
}
