import type { Context } from "cordis";
import SkillsInstallerSection from "./SkillsInstallerSection.tsx";
import { SkillsSourceSettings } from "./SkillsSourceSettings.tsx";

export const name = "skills-workbench";
export const inject = ["skills", "workbench"];

export function apply(ctx: Context): void {
  const { skills, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("skills", { id: "skills", service: skills }),
  );
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "skills",
      reset: () => skills.source.set(""),
    }),
  );
  ctx.effect(() =>
    workbench.register("chrome", {
      id: "skills-source",
      View: () => <SkillsSourceSettings source={skills.source} />,
    }),
  );
  ctx.effect(() =>
    workbench.register("chrome", {
      id: "skills-installer",
      View: () => <SkillsInstallerSection skills={skills} />,
    }),
  );
}
