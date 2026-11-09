/** Resolve the worktree-relative launcher for a configured Skills source. */
export function deriveAawScriptPath(skillsSourceDir: string): string {
  const trimmed = skillsSourceDir.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") {
    return "";
  }
  return `${trimmed}/aaw-workflow/scripts/aaw.py`;
}
