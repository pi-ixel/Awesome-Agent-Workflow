/** 运行管理与模板历史共用的运行行。 */
import type { RunSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { formatAgo } from "./time.ts";
import { Badge, StatusDot } from "../../../shared/ui/controls.tsx";
import { runTone } from "./nodeText.ts";

export function RunRow({
  run,
  now,
  ordinal,
  workflowName,
  suffix = "",
  onOpen,
}: {
  run: RunSummary;
  now: number;
  /** 同一工作流的第几次；undefined 表示不编号。 */
  ordinal?: number;
  /** 副行开头写的工作流名；空字符串表示这行与前一行属于同一工作流。 */
  workflowName: string;
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
      ) : (
        <Badge tone={runTone(run.status, blocked)}>{label}</Badge>
      )}
    </span>
  </button>;
}
