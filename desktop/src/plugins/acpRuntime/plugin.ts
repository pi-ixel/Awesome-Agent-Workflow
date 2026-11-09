import type { Context } from "cordis";
import { DesktopAcpRuntime } from "./service.ts";

export const name = "acpRuntime";
export const inject = ["acpConnection", "agents", "diagnostics"];

export function apply(ctx: Context): void {
  const agents = ctx.agents;
  const service = new DesktopAcpRuntime(ctx.acpConnection, agents);
  ctx.provide(name, service);
  ctx.effect(() => () => service.shutdown(), "acpRuntime:resources");
  ctx.effect(
    () => agents.registerProbeSessions(service.createProbeLease),
    "acpRuntime:agent-probe-sessions",
  );
}
