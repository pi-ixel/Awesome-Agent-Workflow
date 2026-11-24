/** 运行管理的运行行：左边状态图标，右边标题与副行；右下角问号里的图标说明也在这里。 */
import { useId, useState } from "react";
import type { RunSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { formatAgo } from "./time.ts";
import { CircleHelpIcon } from "../../../shared/ui/icons.tsx";
import { RUN_MARKS, runMarkKind, type RunMarkKind } from "./runMarks.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { HintSurface } from "../../../shared/ui/controls/HintSurface.tsx";

function MarkGlyph({ kind }: { kind: RunMarkKind }) {
  return <>{RUN_MARKS.find((item) => item.kind === kind)?.icon}</>;
}

/** 图标说明：收在页面右下角的问号里，悬停或聚焦时在它上方弹出一行。 */
export function RunMarkLegend() {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return <div className="workflow-run-help" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <IconButton iconSize="compact" className="rounded-control text-ink-mute transition-colors hover:bg-surface-hover hover:text-ink" aria-label="状态图标说明" aria-describedby={id}>
      <CircleHelpIcon className="ui-icon-16" />
    </IconButton>
    <HintSurface id={id} open={hovered || focused} unfoldFrom="right" className="workflow-run-legend">
      <ul>
        {RUN_MARKS.map((item) => <li key={item.kind}>
          <span className={`workflow-run-mark tone-${item.kind}`} aria-hidden="true">{item.icon}</span>
          {item.label}
        </li>)}
      </ul>
    </HintSurface>
  </div>;
}

export function RunRow({
  run,
  now,
  ordinal,
  workflowName,
  showEntry = false,
  suffix = "",
  onOpen,
}: {
  run: RunSummary;
  now: number;
  /** 同一工作流的第几次；undefined 表示不编号。 */
  ordinal?: number;
  /** 副行开头写的工作流名；空字符串表示这行与前一行属于同一工作流。和标题相同时不重复写。 */
  workflowName: string;
  /** 写出从哪个起点开始：同一工作流的运行起点不全一样时才有区分作用。 */
  showEntry?: boolean;
  /** 追加在标题后的说明（如「已归档」）。 */
  suffix?: string;
  onOpen: () => void;
}) {
  const label = statusLabel(run);
  const kind = runMarkKind(run);
  const ordinals = ordinal === undefined ? "" : ` 第 ${ordinal} 次`;
  const meta = [
    workflowName !== run.title ? workflowName : "",
    showEntry ? run.entryLabel : "",
    run.updatedAt != null ? formatAgo(run.updatedAt, now) : "",
  ].filter(Boolean).join(" · ");
  return <NavigationRow layout="compound" className="workflow-run-open" onClick={onOpen} aria-label={`查看运行 ${run.title}${ordinals}`}>
    <span className={`workflow-run-mark tone-${kind}`} aria-hidden="true" {...hintTooltipProps(label)}><MarkGlyph kind={kind} /></span>
    <span className="workflow-run-list-title" data-hint={run.title}>
      <span className="workflow-run-list-name">{`${run.title}${suffix}`}</span>
      {ordinal !== undefined && <em>{`第 ${ordinal} 次`}</em>}
    </span>
    {meta !== "" && <span className="workflow-run-list-meta">{meta}</span>}
  </NavigationRow>;
}
