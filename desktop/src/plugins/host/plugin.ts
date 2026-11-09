import type { Context } from "cordis";
import type { HostOptions } from "../../contracts/host.ts";
import { DesktopHost } from "./service.ts";

export const name = "host";
export const inject = [];

export function apply(ctx: Context, options?: HostOptions): void {
  const service = new DesktopHost(options);
  ctx.provide(name, service);
  ctx.effect(() => () => service.dispose(), "host:resources");
}
