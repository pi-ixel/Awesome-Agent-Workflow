/** 运行搜索（ADR 036）。 */
import type { ProjectRunSummary, RunSummary } from "../types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";

/** 标题、工作流名、起点和需求原文里都能搜到。 */
export function matchesRun(run: RunSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [run.title, run.name, run.entryLabel, run.requirement].filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

const busyRun = (run: RunSummary) => run.status === "running" || run.status === "waiting";

/** 按项目分组：有运行在进行的项目在前，其余按最近更新。 */
export function groupByProject(runs: readonly ProjectRunSummary[]): { project: string; runs: ProjectRunSummary[] }[] {
  const groups = new Map<string, { project: string; runs: ProjectRunSummary[] }>();
  for (const run of runs) {
    const key = pathKey(run.project);
    const group = groups.get(key) ?? { project: run.project, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  const latest = (group: { runs: ProjectRunSummary[] }) => Math.max(0, ...group.runs.map((run) => run.updatedAt ?? 0));
  return [...groups.values()].sort((a, b) =>
    Number(b.runs.some(busyRun)) - Number(a.runs.some(busyRun)) || latest(b) - latest(a));
}
