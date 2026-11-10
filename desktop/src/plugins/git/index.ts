import type { Context } from "cordis";
import type { GitService } from "./service.ts";
import { createGitService } from "./repository/git.ts";

export const name = "git";
export const inject = ["host", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const git = createGitService(ctx.host.git, ctx.host.storage);
  ctx.provide(name, {
    get reviewRailWidth() { return git.reviewRailWidth; },
    setReviewRailWidth: git.setReviewRailWidth,
    status: (project) => git.status(project),
    diff: (project, change) => git.diff(project, change),
    query: git.query,
  } satisfies GitService);
  ctx.effect(() => () => git.dispose(), "git:resources");
}
