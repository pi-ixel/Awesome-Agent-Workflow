import type { PanelLayoutCompatibility } from "../workbench/types.ts";

/** Shared by successive Workflow UI installs to keep the saved drawer preference. */
export const timelineCollapsedStorageKey = "aaw-desktop/layout/timeline-collapsed";

export const workflowPanelCompatibility: PanelLayoutCompatibility = {
  tabs: [{ kind: "aaw", singleton: true }],
  toolView: {
    id: "aaw",
    read: (panel) => panel.aawSegment === "launch" ? "launch" : undefined,
  },
};

/** Resolve the worktree-relative launcher for a configured Skills source. */
export function deriveAawScriptPath(skillsSourceDir: string): string {
  const trimmed = skillsSourceDir.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") {
    return "";
  }
  return `${trimmed}/aaw-workflow/scripts/aaw.py`;
}
