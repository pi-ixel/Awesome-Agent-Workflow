import type { Context } from "cordis";
import { createStore } from "zustand";
import type { PanelTab, WorkbenchContributions } from "../../workbench/types.ts";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import type { ProjectWorkspace } from "../../project/service.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { GitService } from "../service.ts";
import { GitDiffView } from "./GitDiffView.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { createGitRevealCursor } from "../review/review.ts";
import { pathKey, pathName } from "../../../shared/panelPaths.ts";
import { FileDiffIcon } from "../../../shared/ui/icons.tsx";
import { FileDisplayIcon } from "../../../shared/ui/file-icons/fileDisplay.tsx";
import { resolveIconName } from "../../../shared/ui/file-icons/fileDisplayHelpers.ts";
import { readDiffReference } from "../review/diffReference.ts";
import { createGitReviewNavigation, type GitReviewReveal } from "./reviewNavigation.ts";

/** Diff tabs from existing layouts remain readable after review moved into its own panel. */
function readDiffTab(tab: PanelTab | undefined) {
  return tab?.kind === "diff" && tab.data ? readDiffReference(tab.data) : undefined;
}

export function gitPanels(
  git: GitService,
  activity?: ReadonlySnapshot<{ readonly watch?: ProjectWorkspace["subscribeWorkspaceActivity"] }>,
  requests?: ReadonlySnapshot<Readonly<Record<string, GitReviewReveal>>>,
): readonly WorkbenchContributions["panels"][] {
  const reveal = createGitRevealCursor();
  return [
    {
      id: "git",
      launcher: {
        label: "审查",
        description: "审查工作区更改",
        Icon: FileDiffIcon,
        searchHint: "git diff",
        hideWhenOpen: true,
        order: 10,
      },
      key: ({ project }) => project,
      View: function GitReviewPanel({ project }) {
        const watchActivity = useRegisteredSnapshot(activity, (state) => state?.watch);
        const request = useRegisteredSnapshot(requests, (state) => state?.[pathKey(project)]);
        return (
          <GitPanel
            project={project}
            git={git}
            reveal={reveal}
            revealRequest={request}
            watchActivity={watchActivity}
          />
        );
      },
    },
    {
      id: "diff",
      present(tab) {
        const entry = readDiffTab(tab);
        if (!entry) return undefined;
        const { path, change } = entry;
        const sourceLabel = change.source === "staged" ? "已暂存" : "工作区";
        return {
          title: pathName(path),
          tooltip: `${sourceLabel} · ${path}`,
          searchHint: `${change.path} ${sourceLabel}`,
          typeLabel: "Diff",
          badge: "Diff",
          icon: change.path ? (
            <FileDisplayIcon name={resolveIconName(change.path)} size={14} className="shrink-0" />
          ) : <FileDiffIcon className="size-3.5 shrink-0" />,
        };
      },
      View: function GitPatchPanel({ project, tab, openPath }) {
        const watchActivity = useRegisteredSnapshot(activity, (state) => state?.watch);
        const entry = readDiffTab(tab);
        return entry && (
          <GitDiffView
            project={project}
            gitService={git}
            repoRoot={entry.repoRoot}
            change={entry.change}
            onFile={openPath}
            watchActivity={watchActivity}
          />
        );
      },
    },
  ];
}

export const name = "git-workbench";
export const inject = ["git", "workbench"];

export function apply(ctx: Context): void {
  const { git, workbench } = ctx;
  const review = createGitReviewNavigation(workbench);
  ctx.provide("gitUi", review.navigation);
  ctx.effect(() => () => review.dispose(), "git:review-navigation");
  const activity = createStore<{
    watch?: ProjectWorkspace["subscribeWorkspaceActivity"];
  }>(() => ({}));
  ctx.effect(() => {
    const binding = ctx.inject(["project"], function gitWorkspaceActivity(scoped) {
      const { subscribeWorkspaceActivity } = scoped.project.projects;
      scoped.effect(() => {
        activity.setState({ watch: subscribeWorkspaceActivity });
        return () => activity.setState({}, true);
      });
    });
    return () => binding.dispose();
  }, "git:workspace-activity");
  for (const panel of gitPanels(git, activity, review.requests))
    ctx.effect(() => workbench.register("panels", panel));
}
