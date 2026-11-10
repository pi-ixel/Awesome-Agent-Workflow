import type { Context } from "cordis";
import SettingsPage from "./SettingsPage.tsx";
import { workbenchSettings } from "./settingsContributions.tsx";

export const name = "workbench-ui";
export const inject = ["workbench"];

export function apply(ctx: Context): void {
  const { workbench } = ctx;
  ctx.effect(() => workbench.register("pages", { id: "settings", View: SettingsPage }));
  for (const settings of workbenchSettings)
    ctx.effect(() => workbench.register("settings", settings));
}
