import type { Context } from "cordis";
import { DesktopAcpConnection } from "./service.ts";

export const name = "acpConnection";
export const inject = ["host", "diagnostics"];

export function apply(ctx: Context): void {
  const service = new DesktopAcpConnection(ctx.host);
  ctx.provide(name, service);
  ctx.effect(() => () => service.shutdown(), "acpConnection:resources");
}
