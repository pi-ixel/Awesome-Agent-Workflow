import type { Context } from "cordis";
import { desktopSettingsKey } from "../configuration/service.ts";
import { skillsSourceField } from "./config.ts";
import { createSkills } from "./sources/skills.ts";

export const name = "skills";
export const inject = ["host", "agents", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const agents = ctx.agents;
  const scope = ctx.configuration.register(desktopSettingsKey, [
    skillsSourceField,
  ]);
  ctx.effect(() => () => scope.dispose(), "skills:source-configuration");
  const { dispose, ...skills } = createSkills(
    ctx.host.skills,
    scope,
    () => agents.resolve()?.skillInstallation,
    (listener) => agents.subscribeSelection(listener),
    ctx.diagnostics.createLogger,
  );
  ctx.provide(name, skills);
  ctx.effect(() => dispose, "skills:resources");
}
