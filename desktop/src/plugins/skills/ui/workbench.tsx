import type { Context } from "cordis";
import type { SkillsSettingsView } from "../types.ts";
import SkillsInstallerSection from "./SkillsInstallerSection.tsx";
import { SkillsSourceSettings } from "./SkillsSourceSettings.tsx";

export const name = "skills-workbench";
export const inject = ["skills", "workbench"];

export function apply(ctx: Context): void {
  const { skills, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "skills",
      label: "Skills 源目录",
      reset: () => skills.setSourceDirectory(""),
    }),
  );
  const view: SkillsSettingsView = {
    Source: () => (
      <SkillsSourceSettings source={skills.source} onChange={(directory) => skills.setSourceDirectory(directory)} />
    ),
    Installer: () => <SkillsInstallerSection skills={skills} />,
  };
  ctx.provide("skillsUi", view);
}
