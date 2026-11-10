import type { Context } from "cordis";
import { DesktopAcpRuntime } from "./sessions/runtimeService.ts";

export const name = "acpRuntime";
export const inject = ["acpConnection", "agents", "diagnostics"];

export function apply(ctx: Context): void {
  const agents = ctx.agents;
  const runtime = new DesktopAcpRuntime(ctx.acpConnection, agents, ctx.diagnostics.createLogger("acp"));
  ctx.provide(name, runtime.service);
  ctx.effect(() => () => runtime.shutdown(), "acpRuntime:resources");
  ctx.effect(
    () => agents.registerProbeSessions(runtime.createProbeLease),
    "acpRuntime:agent-probe-sessions",
  );
}
