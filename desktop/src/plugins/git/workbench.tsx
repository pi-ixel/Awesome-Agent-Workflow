import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../contracts/workbench.ts";
import type { GitService } from "../../contracts/git.ts";
import { GitDiffView } from "./ui/GitDiffView.tsx";
import { GitPanel } from "./ui/GitPanel.tsx";
import { createGitRevealCursor } from "./review.ts";

export function gitPanels(
  git: GitService,
): readonly WorkbenchContributions["panels"][] {
  const reveal = createGitRevealCursor();
  return [
    {
      id: "git",
      key: ({ project }) => project,
      View: ({ project }) => (
        <GitPanel project={project} git={git} reveal={reveal} />
      ),
    },
    {
      id: "diff",
      View: ({ project, tab, openPath }) =>
        tab?.kind === "diff" && (
          <GitDiffView
            project={project}
            gitService={git}
            repoRoot={tab.repoRoot}
            change={tab.change}
            onFile={openPath}
          />
        ),
    },
  ];
}

export const name = "git-workbench";
export const inject = ["git", "workbench"];

export function apply(ctx: Context): void {
  const { git, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("gitReview", { id: "git", service: git }),
  );
  for (const panel of gitPanels(git))
    ctx.effect(() => workbench.register("panels", panel));
}
