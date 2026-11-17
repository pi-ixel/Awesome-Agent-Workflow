/**
 * 运行列表的一行与一张列表（库页「运行」页签、工作流详情的本项目运行、全部运行共用）。
 *
 * 一行的三段：
 * - 标题：运行标题；同一工作流的多次运行在标题后加「第 N 次」（由 runList.ts 编号）；
 * - 副行：工作流名（只在换了一个工作流时写）· 起点 · 相对时间；
 * - 右端：状态。默认挂徽标；`quiet` 时「已完成」不挂——整列都是同色徽标时
 *   颜色就不是信号了，只有要你注意的状态才值得占一个徽标。
 */
import type { RunSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { formatAgo } from "./time.ts";
import { Badge, StatusDot } from "../../../shared/ui/controls.tsx";
import { runTone } from "./nodeText.ts";
import { ordinalOf } from "./runList.ts";

export function RunRow({
  run,
  now,
  ordinal,
  workflowName,
  quiet = false,
  suffix = "",
  onOpen,
}: {
  run: RunSummary;
  now: number;
  /** 同一工作流的第几次；undefined 表示不编号。 */
  ordinal?: number;
  /** 副行开头写的工作流名；空字符串表示这行与前一行属于同一工作流。 */
  workflowName: string;
  /** 已完成不挂徽标（库页列表用）。 */
  quiet?: boolean;
  /** 追加在标题后的说明（如「已归档」）。 */
  suffix?: string;
  onOpen: () => void;
}) {
  const label = statusLabel(run);
  const blocked = label.startsWith("已阻塞");
  const ordinals = ordinal === undefined ? "" : ` 第 ${ordinal} 次`;
  const meta = [workflowName, run.entryLabel, run.updatedAt != null ? formatAgo(run.updatedAt, now) : ""]
    .filter(Boolean)
    .join(" · ");
  return <button type="button" onClick={onOpen} aria-label={`查看运行 ${run.title}${ordinals}`}>
    <span className="workflow-run-list-title" data-hint={run.title}>
      <span className="workflow-run-list-name">{`${run.title}${suffix}`}</span>
      {ordinal !== undefined && <em>{`第 ${ordinal} 次`}</em>}
    </span>
    <span className="workflow-run-list-meta">{meta}</span>
    <span className="workflow-run-list-state">
      {run.status === "running" ? (
        <span className="workflow-run-list-running">
          <StatusDot tone="info" pulse />
          {label}
        </span>
      ) : quiet && run.status === "completed" ? null : (
        <Badge tone={runTone(run.status, blocked)}>{label}</Badge>
      )}
    </span>
  </button>;
}

export function RunList({
  runs,
  now,
  onOpenRun,
  quiet = false,
  groupWorkflow = false,
  ordinals,
}: {
  runs: readonly RunSummary[];
  now: number;
  onOpenRun: (runId: string) => void;
  /** 已完成不挂徽标。 */
  quiet?: boolean;
  /** 相邻行同属一个工作流时不再重复写工作流名。 */
  groupWorkflow?: boolean;
  /** 编号表：列表被拆成两段（待处理 / 其余）时由调用处按全部运行算好再传，序号才不重来。 */
  ordinals?: Readonly<Record<string, number>>;
}) {
  const numbers = ordinals ?? ordinalOf(runs);
  return <ul className="workflow-run-list">
    {runs.map((run, index) => <li key={run.runId}>
      <RunRow
        run={run}
        now={now}
        ordinal={numbers[run.runId]}
        workflowName={groupWorkflow && index > 0 && runs[index - 1]?.workflowId === run.workflowId ? "" : run.name}
        quiet={quiet}
        onOpen={() => onOpenRun(run.runId)}
      />
    </li>)}
  </ul>;
}
