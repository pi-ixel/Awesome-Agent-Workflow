import type { Context } from "cordis";
import { desktopSettingsKey } from "../../contracts/configuration.ts";
import { createSkills, skillsSourceField } from "./service.ts";

export const name = "skills";
export const inject = ["host", "agents", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const agents = ctx.agents;
  const scope = ctx.configuration.register(desktopSettingsKey, [
    skillsSourceField,
  ]);
  ctx.effect(() => () => scope.dispose(), "skills:source-configuration");
  const skills = createSkills(
    ctx.host.skills,
    scope,
    (id) => agents.resolve(id)?.skillInstallation,
    (listener) => agents.subscribeSelection(listener),
  );
  ctx.provide(name, skills);
  ctx.effect(() => () => skills.dispose(), "skills:resources");
}
