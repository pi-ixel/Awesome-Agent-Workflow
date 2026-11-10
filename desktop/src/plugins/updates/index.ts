import type { Context } from "cordis";
import { createUpdates } from "./updater/updates.ts";

export const name = "updates";
export const inject = ["host", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const { start, dispose, ...updates } = createUpdates(
    ctx.host.updates,
    ctx.host.shell.openExternal,
    ctx.diagnostics.createLogger("desktop-update"),
  );
  ctx.provide(name, updates);
  // The updater starts with this Fiber, including when the settings view is closed.
  ctx.effect(() => {
    start();
    return dispose;
  }, "updates:resources");
}
