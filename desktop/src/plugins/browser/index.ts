import type { Context } from "cordis";

export const name = "browser";
export const inject = ["host"];

export function apply(ctx: Context): void {
  ctx.provide(name, { host: ctx.host.browser });
  ctx.effect(() => () => {}, "browser:resources");
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
