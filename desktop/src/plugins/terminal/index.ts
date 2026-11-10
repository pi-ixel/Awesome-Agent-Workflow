import type { Context } from "cordis";
import { createTerminalService } from "./pty/terminal.ts";

export const name = "terminal";
export const inject = ["host", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.ts"));
}
export function apply(ctx: Context): void {
  const { dispose, ...terminal } = createTerminalService(
    ctx.host.terminal,
    ctx.host.exitGate.isExiting,
    ctx.diagnostics.createLogger("pty"),
  );
  ctx.provide(name, terminal);
  ctx.effect(() => dispose, "terminal:resources");
}
