import type { Context } from "cordis";
import {
  createProjectSidebar,
  projectChrome,
  projectPages,
} from "./workbenchViews.tsx";
import { projectSettings } from "./settings.tsx";
import { registerProjectExit } from "./lifecycle.ts";
import { withProjectPreferences } from "./preferencesView.tsx";

export const name = "project-workbench";
export const inject = ["project", "workbench"];

export function apply(ctx: Context): void {
  const { project, workbench } = ctx;
  const Sidebar = withProjectPreferences(createProjectSidebar(project), project.preferences);
  ctx.effect(() =>
    workbench.register("project", { id: "project", service: project }),
  );
  ctx.effect(() =>
    workbench.register("sidebar", {
      id: "project-tree",
      View: Sidebar,
    }),
  );
  for (const page of projectPages)
    ctx.effect(() =>
      workbench.register("pages", {
        ...page,
        View: withProjectPreferences(page.View, project.preferences),
      }),
    );
  for (const chrome of projectChrome)
    ctx.effect(() =>
      workbench.register("chrome", {
        ...chrome,
        View: withProjectPreferences(chrome.View, project.preferences),
      }),
    );
  for (const settings of projectSettings)
    ctx.effect(() =>
      workbench.register("settings", {
        ...settings,
        View: withProjectPreferences(settings.View, project.preferences),
      }),
    );
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "project",
      reset: () => project.preferences.reset(),
    }),
  );
  ctx.effect(() =>
    workbench.register("actions", {
      id: "settings.archive",
      run: () => workbench.navigation.getState().openSettingsTab("archive"),
    }),
  );
  ctx.effect(() => registerProjectExit(workbench, project));
}
