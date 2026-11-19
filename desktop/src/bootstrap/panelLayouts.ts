import { documentPanelCompatibility } from "../plugins/documents/service.ts";
import { gitPanelCompatibility } from "../plugins/git/service.ts";
import { workflowPanelCompatibility } from "../plugins/workflow/service.ts";

export const desktopPanelLayouts = [
  documentPanelCompatibility,
  gitPanelCompatibility,
  workflowPanelCompatibility,
] as const;
