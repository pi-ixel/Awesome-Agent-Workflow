import type { Context } from "cordis";
import { createTerminalService } from "./service.ts";

export const name = "terminal";
export const inject = ["host", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const terminal = createTerminalService(ctx.host.terminal, ctx.host.exitGate.isExiting);
  ctx.provide(name, terminal);
  ctx.effect(() => () => terminal.dispose(), "terminal:resources");
}
