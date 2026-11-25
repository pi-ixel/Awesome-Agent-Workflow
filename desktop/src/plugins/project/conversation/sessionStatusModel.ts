import type { ProjectActivity } from "../ui/extension.ts";
import type { GitSnapshot } from "../../host/types.ts";
import type { PlanEntry } from "../../../contracts/acp/protocol.ts";

export function gitStatusSummary(snapshot?: GitSnapshot) {
  if (!snapshot?.repoRoot) return null;
  const tracked = snapshot.changes.filter(
    (change) => change.source !== "branch" && change.source !== "untracked",
  );
  if (!tracked.length) return null;
  const added = tracked.reduce(
    (total, change) => total + (change.added ?? 0),
    0,
  );
  const removed = tracked.reduce(
    (total, change) => total + (change.removed ?? 0),
    0,
  );
  return {
    added,
    removed,
    ...(tracked.some((c) => c.statsUnavailable)
      ? { statsUnavailable: true }
      : {}),
    count: new Set(tracked.map((c) => c.path)).size,
    branch: snapshot.branch,
    source: tracked.some((change) => change.source !== "staged")
      ? ("unstaged" as const)
      : ("staged" as const),
  };
}

export function taskProgressSummary(entries: readonly PlanEntry[]) {
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  let index = entries.findIndex((entry) => entry.status === "in_progress");
  if (index < 0)
    index = entries.findIndex((entry) => entry.status !== "completed");
  const start =
    entries.length <= 6
      ? 0
      : Math.min(index < 0 ? entries.length - 3 : index, entries.length - 3);
  return {
    entries,
    done,
    total: entries.length,
    current: index < 0 ? null : (entries[index] ?? null),
    completed: done === entries.length,
    start,
    end: entries.length <= 6 ? entries.length : start + 3,
  };
}
export type TaskProgressSummary = NonNullable<
  ReturnType<typeof taskProgressSummary>
>;

export function compactStatusSummary(
  task: TaskProgressSummary | null,
  run: Pick<ProjectActivity, "summary"> | null,
  git: ReturnType<typeof gitStatusSummary>,
): string {
  if (task?.current) return task.current.content;
  if (run) return run.summary;
  if (git)
    return `Changes ${git.count}`;
  if (task?.completed) return `任务已完成 ${task.done}/${task.total}`;
  return "会话状态";
}
