/** 运行搜索（ADR 036）。 */
import type { RunSummary } from "../types.ts";

/** 标题、工作流名、起点和需求原文里都能搜到。 */
export function matchesRun(run: RunSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [run.title, run.name, run.entryLabel, run.requirement].filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}
