import type { Context } from "cordis";
import { desktopSettingsKey } from "../../contracts/configuration.ts";
import { DesktopAgents } from "./service.ts";
import { agentPreferenceFields } from "./settings.ts";

export const name = "agents";
export const inject = ["host", "configuration", "diagnostics", "acpConnection"];

export function apply(ctx: Context): void {
  const configuration = ctx.configuration;
  const scope = configuration.register(
    desktopSettingsKey,
    agentPreferenceFields,
  );
  ctx.effect(() => () => scope.dispose(), "agents:configuration");
  const service = new DesktopAgents(
    ctx.host.commands,
    ctx.host.archives,
    ctx.acpConnection,
    scope,
    () => configuration.read(desktopSettingsKey),
  );
  ctx.provide(name, service);
  ctx.effect(() => {
    void service.initialize();
    return () => service.shutdown();
  }, "agents:resources");
}
