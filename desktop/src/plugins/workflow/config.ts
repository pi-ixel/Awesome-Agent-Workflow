import type { PanelLayoutCompatibility } from "../workbench/types.ts";

export const workflowPanelCompatibility: PanelLayoutCompatibility = {
  tabs: [{ kind: "aaw", singleton: true }],
  // 旧布局的 aawSegment（launch/progress 分段）随启动器并入面板而消失；
  // 这里仍读取以完成历史布局迁移（迁移出的 toolView 值新面板不再消费）。
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
