import { documentPanelCompatibility } from "../plugins/documents/config.ts";
import { gitPanelCompatibility } from "../plugins/git/config.ts";
import { workflowPanelCompatibility } from "../plugins/workflow/config.ts";

export const desktopPanelLayouts = [
  documentPanelCompatibility,
  gitPanelCompatibility,
  workflowPanelCompatibility,
] as const;
