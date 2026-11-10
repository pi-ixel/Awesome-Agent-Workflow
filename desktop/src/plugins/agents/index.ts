import type { Context } from "cordis";
import { desktopSettingsKey } from "../configuration/service.ts";
import { DesktopAgents } from "./lifecycle/agents.ts";
import { agentPreferenceFields } from "./config.ts";

export const name = "agents";
export const inject = ["host", "configuration", "diagnostics", "acpConnection"];

export async function installWorkbench(ctx: Context): Promise<void> {
  const workbench = await import("./ui/workbench.tsx");
  await ctx.plugin(workbench);
  await ctx.plugin(workbench.agentSettings);
}

export function apply(ctx: Context): void {
  const configuration = ctx.configuration;
  const scope = configuration.register(
    desktopSettingsKey,
    agentPreferenceFields,
  );
  ctx.effect(() => () => scope.dispose(), "agents:configuration");
  const agents = new DesktopAgents(
    ctx.host.commands,
    ctx.host.archives,
    ctx.acpConnection,
    scope,
    () => configuration.read(desktopSettingsKey),
    ctx.diagnostics.createLogger,
  );
  ctx.provide(name, agents.service);
  ctx.effect(() => ctx.diagnostics.registerStorage({
    id: "agents.settings",
    label: "Agent 配置",
    risk: "",
    list() {
      const values = scope.read();
      if (!values || !Object.keys(values).length) return [];
      return [{ key: "agent-settings", bytes: JSON.stringify(values).length * 2, revision: null }];
    },
    saveFailure: scope.saveFailure,
  }), "agents:storage");
  ctx.effect(() => {
    void agents.initialize();
    return () => agents.shutdown();
  }, "agents:resources");
}
