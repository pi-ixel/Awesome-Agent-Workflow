/** 运行管理、模板历史与项目总览共用的运行行。 */
import type { RunSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { formatAgo } from "./time.ts";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { Badge, StatusDot } from "../../../shared/ui/controls.tsx";
import { runTone } from "./nodeText.ts";

export function RunRow({
  run,
  now,
  ordinal,
  workflowName,
  showEntryLabel = true,
  suffix = "",
  onOpen,
}: {
  run: RunSummary;
  now: number;
  /** 同一工作流的第几次；undefined 表示不编号。 */
  ordinal?: number;
  /** 副行开头写的工作流名；空字符串表示这行与前一行属于同一工作流。 */
  workflowName: string;
  showEntryLabel?: boolean;
  /** 追加在标题后的说明（如「已归档」）。 */
  suffix?: string;
  onOpen: () => void;
}) {
  const label = statusLabel(run);
  const blocked = label.startsWith("已阻塞");
  const ordinals = ordinal === undefined ? "" : ` 第 ${ordinal} 次`;
  const meta = [
    workflowName,
    showEntryLabel ? run.entryLabel : "",
    run.updatedAt != null ? formatAgo(run.updatedAt, now) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <NavigationRow
      layout="compound"
      onClick={onOpen}
      aria-label={`查看运行 ${run.title}${ordinals}`}
      className="grid! w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 px-2 py-1.5 text-ui-base hover:bg-surface-hover"
    >
      <span
        className="flex min-w-0 items-center gap-1.5 text-ink"
        data-hint={run.title}
      >
        <span className="truncate">{`${run.title}${suffix}`}</span>
        {ordinal !== undefined && (
          <em className="shrink-0 text-2xs text-ink-mute not-italic">{`第 ${ordinal} 次`}</em>
        )}
      </span>
      <span className="col-start-1 truncate text-2xs text-ink-mute">
        {meta}
      </span>
      <span className="col-start-2 row-span-2 row-start-1 self-center text-ui-sm text-ink-soft">
        {run.status === "running" ? (
          <span className="inline-flex items-center gap-1.5 text-info-ink">
            <StatusDot tone="info" pulse />
            {label}
          </span>
        ) : (
          <Badge tone={runTone(run.status, blocked)}>{label}</Badge>
        )}
      </span>
    </NavigationRow>
  );
}
