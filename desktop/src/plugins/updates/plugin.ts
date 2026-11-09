import type { Context } from "cordis";
import { createUpdates } from "./service.ts";

export const name = "updates";
export const inject = ["host", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const updates = createUpdates(ctx.host.updates, ctx.host.shell.openExternal);
  ctx.provide(name, updates);
  // The updater starts with this Fiber, including when the settings view is closed.
  ctx.effect(() => {
    updates.start();
    return () => updates.dispose();
  }, "updates:resources");
}
