import type { Context } from "cordis";
import { DesktopConfiguration } from "./service.ts";

export const name = "configuration";
export const inject = ["host"];

export function apply(ctx: Context): void {
  const service = new DesktopConfiguration(ctx.host.storage);
  ctx.provide(name, service);
  ctx.effect(() => () => service.dispose(), "configuration:resources");
}
