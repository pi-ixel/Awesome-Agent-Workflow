import type { WorkbenchContributions } from "../../../contracts/workbench.ts";
import SettingsPage from "./SettingsPage.tsx";

export const settingsPage: WorkbenchContributions["pages"] = {
  id: "settings",
  View: SettingsPage,
};
