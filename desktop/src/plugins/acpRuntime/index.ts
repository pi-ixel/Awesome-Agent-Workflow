import type { Context } from "cordis";
import { DesktopAcpRuntime } from "./sessions/runtimeService.ts";
import type { AcpConnectionInternals } from "../acpConnection/service.ts";

export const name = "acpRuntime";
export const inject = ["acpConnection", "agents", "diagnostics"];

export function apply(ctx: Context): void {
  const agents = ctx.agents;
  // 插件可见的服务面（AcpConnectionService）不含建池能力；本插件是全仓
  // 唯一的池装配点（架构守卫 acpPoolBoundary 只放行这一处收窄）。
  const runtime = new DesktopAcpRuntime(ctx.acpConnection as AcpConnectionInternals, agents, ctx.diagnostics.createLogger("acp"));
  ctx.provide(name, runtime.service);
  ctx.effect(() => () => runtime.shutdown(), "acpRuntime:resources");
  ctx.effect(
    () => agents.registerProbeSessions(runtime.createProbeLease),
    "acpRuntime:agent-probe-sessions",
  );
}
