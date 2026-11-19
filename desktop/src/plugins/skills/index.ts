import type { Context } from "cordis";
import { desktopSettingsKey } from "../configuration/service.ts";
import { skillsSourceField } from "./config.ts";
import { createSkills } from "./sources/skills.ts";
import {
  slashSkillCatalog,
  slashSkillDescriptions,
} from "./sources/slashSkillCatalog.ts";

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
  const library = ctx.host.skills.library;
  ctx.provide(name, {
    ...skills,
    resolveSlashSkills: (agentId) => {
      const adapter = agents.resolve(agentId);
      if (!adapter?.slashSkillSource) return undefined;
      const provider = adapter.skillLibrary;
      if (!library || !provider) return {};
      const load = (project: string | null) =>
        library.list({
          provider,
          profile: null,
          projects: project ? [project] : [],
        });
      return adapter.slashSkillSource === "catalog"
        ? {
            listCatalog: async (project) =>
              slashSkillCatalog(await load(project), project),
          }
        : {
            listDescriptions: async (project) =>
              slashSkillDescriptions(await load(project), project),
          };
    },
  });
  ctx.effect(() => dispose, "skills:resources");
}
