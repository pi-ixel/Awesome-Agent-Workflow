import type { Context } from "cordis";
import { createGitService } from "./service.ts";

export const name = "git";
export const inject = ["host", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const git = createGitService(ctx.host.git, ctx.host.storage);
  ctx.provide(name, git);
  ctx.effect(() => () => git.dispose(), "git:resources");
}
