/**
 * 运行列表的纯逻辑（渲染在 RunList.tsx）：哪些运行要你处理、同一工作流的第几次。
 *
 * 两个函数都只看 RunSummary 列表，不碰服务、不碰时钟——便于单测。
 */
import type { RunSummary } from "../types.ts";

/**
 * 要你处理：等你确认的，以及流程停下（阻塞）的。
 *
 * 其余状态（已完成、已停止、只是失败）都是「结果」，不需要当下动作——
 * 运行管理把它们和待处理运行分开，才不会让人逐行读徽标。
 */
export function attentionOf(runs: readonly RunSummary[]): readonly RunSummary[] {
  return runs.filter(
    (run) => run.status === "waiting" || run.status === "blocked",
  );
}

/**
 * runId → 这是这个工作流的第几次运行（按 createdAt 升序；缺时间时按 runId 排）。
 *
 * 同一个工作流只跑过一次不编号——「第 1 次」不提供任何区分度。
 * 编号按全部运行算（含已归档），否则归档一次会让后面的序号集体前移。
 */
export function ordinalOf(
  runs: readonly RunSummary[],
): Readonly<Record<string, number>> {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = run.workflowId || run.name;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const ordinals: Record<string, number> = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(
      (a, b) =>
        (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.runId.localeCompare(b.runId),
    );
    ordered.forEach((run, index) => {
      ordinals[run.runId] = index + 1;
    });
  }
  return ordinals;
}
