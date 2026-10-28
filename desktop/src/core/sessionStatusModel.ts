import type { PlanEntry } from "../acp/types.ts";
import {
  deriveStepPhases,
  type AawNextPayload,
  type AawWorkflowStatus,
} from "../aaw/workflowModel.ts";
import type { GitSnapshot } from "./panelService.ts";

export function gitStatusSummary(snapshot?: GitSnapshot) {
  if (!snapshot?.repoRoot) return null;
  const changes = snapshot.changes.filter(
    (change) => change.source !== "branch",
  );
  const untracked = changes.filter((c) => c.source === "untracked");
  const tracked = changes.filter((c) => c.source !== "untracked");
  const added = tracked.reduce(
    (total, change) => total + (change.added ?? 0),
    0,
  );
  const removed = tracked.reduce(
    (total, change) => total + (change.removed ?? 0),
    0,
  );
  if (changes.length === 0) return null;
  return {
    added,
    removed,
    count: new Set(tracked.map((c) => c.path)).size,
    untrackedCount: untracked.length,
    untrackedAdded: untracked.reduce((n, c) => n + (c.added ?? 0), 0),
    branch: snapshot.branch,
    source: changes.some((change) => change.source !== "staged")
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

export function aawStatusSummary(
  status: AawWorkflowStatus | null,
  next: AawNextPayload | null,
) {
  if (!status) return null;
  next = next?.sr === status.sr ? next : null;
  const phases = deriveStepPhases(status.steps);
  const current = status.steps[phases.indexOf("current")];
  const failed = status.steps.find((step) => step.executionStatus === "failed");
  const blocked = status.steps.find(
    (step) => step.executionStatus === "blocked",
  );
  const ready = next?.ready[0];
  const completed = next?.sr === status.sr && next.done;
  const awaiting = next?.sr === status.sr && next.awaitingUserConfirm;
  const label = completed
    ? "已完成"
    : awaiting
      ? "待放行"
      : failed
        ? "执行失败"
        : blocked || ready?.inputs?.blocked
          ? "受阻"
          : current?.executionStatus === "running"
            ? "执行中"
            : "待推进";
  return {
    sr: status.sr,
    label,
    completed,
    warning: !!(awaiting || failed || blocked || ready?.inputs?.blocked),
    done: status.steps.filter((step) => step.finished).length,
    total: status.steps.length,
    step: failed?.name ?? blocked?.name ?? current?.name ?? ready?.name ?? null,
  };
}
export type AawStatusSummary = NonNullable<ReturnType<typeof aawStatusSummary>>;

export function compactStatusSummary(
  task: TaskProgressSummary | null,
  aaw: AawStatusSummary | null,
  git: ReturnType<typeof gitStatusSummary>,
): string {
  if (task?.current) return task.current.content;
  if (aaw && !aaw.completed)
    return `${aaw.sr} · ${aaw.label}${aaw.step ? ` · ${aaw.step}` : ""}`;
  if (git)
    return `Changes ${git.count} · Unversioned Files ${git.untrackedCount}`;
  if (task?.completed) return `任务已完成 ${task.done}/${task.total}`;
  if (aaw?.completed) return `${aaw.sr} · 已完成`;
  return "会话状态";
}
