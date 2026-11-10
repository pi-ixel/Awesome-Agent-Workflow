import type { Context } from "cordis";
import type { ConfigurationService } from "./service.ts";
import { DesktopConfiguration } from "./registry/scopes.ts";

export const name = "configuration";
export const inject = ["host"];

export function apply(ctx: Context): void {
  const configuration = new DesktopConfiguration(ctx.host.storage);
  ctx.provide(name, {
    read: configuration.read.bind(configuration),
    register: configuration.register.bind(configuration),
  } satisfies ConfigurationService);
  ctx.effect(() => () => configuration.dispose(), "configuration:resources");
}
