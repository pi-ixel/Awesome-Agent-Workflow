/** 运行总结页（ADR 035，E4）：概况、各节点做了什么、产出文件。 */
import { shortPath } from "./nodeText.ts";
import type { RunSummaryView, SummaryStep } from "./runSummary.ts";
import { formatDuration, formatStart } from "./time.ts";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";
import { Badge } from "../../../shared/ui/controls.tsx";

export function RunSummaryPage({ summary, now, onSelectStep, onOpenFile }: {
  summary: RunSummaryView;
  now: number;
  onSelectStep: (step: SummaryStep) => void;
  onOpenFile?: (path: string) => void;
}) {
  const elapsed = summary.elapsedMs === null ? "" : formatDuration(summary.elapsedMs);
  const facts: { label: string; value: string }[] = [
    { label: "状态", value: summary.status },
    ...(summary.startedAt === null ? [] : [{ label: "开始", value: formatStart(summary.startedAt, now).trim() }]),
    ...(summary.endedAt === null ? [] : [{ label: "结束", value: formatStart(summary.endedAt, now).trim() }]),
    ...(elapsed ? [{ label: summary.endedAt === null ? "已运行" : "总用时", value: elapsed }] : []),
    ...(summary.waitedMs >= 60_000 ? [{ label: "其中等你", value: formatDuration(summary.waitedMs) }] : []),
    { label: "返工", value: summary.reworks > 0 ? `${summary.reworks} 次` : "没有" },
    ...(summary.confirms > 0 ? [{ label: "你确认放行", value: `${summary.confirms} 次` }] : []),
  ];
  return <div className="workflow-summary" aria-label="运行总结">
    {summary.handoff && <section aria-label="交付说明" className="workflow-summary-handoff">
      <h4>交付说明 · {summary.handoff.from}</h4>
      <p className="workflow-detail-text">{summary.handoff.text}</p>
    </section>}
    <section aria-label="概况">
      <h4>概况</h4>
      <dl className="workflow-detail-facts">
        {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
    </section>

    <section aria-label="各节点">
      <h4>各节点做了什么{summary.superseded > 0 ? `（另有 ${summary.superseded} 轮因回退作废，未列出）` : ""}</h4>
      {summary.steps.length === 0
        ? <EmptyState title="还没有节点执行" />
        : <ol className="workflow-summary-steps">{summary.steps.map((step) => <li key={`${step.siteId}@${step.ordinal}@${step.callPath.join("/")}`}>
          <TextLink data-hint="在画布上查看这个节点" onClick={() => onSelectStep(step)}>
            {step.label}{step.round !== null ? ` · 第 ${step.round} 轮` : ""}
          </TextLink>
          {step.conclusion
            ? <Badge tone={step.conclusion.tone}>{step.conclusion.text}</Badge>
            : <span className="workflow-muted">{step.status}</span>}
          {step.elapsedMs !== null && <small>
            用时 {formatDuration(step.elapsedMs)}{step.waitedMs >= 60_000 ? `（其中等你 ${formatDuration(step.waitedMs)}）` : ""}
          </small>}
        </li>)}</ol>}
    </section>

    <section aria-label="产出文件">
      <h4>产出文件</h4>
      {summary.files.length === 0
        ? <p className="workflow-muted">节点没有在结果里声明文件。</p>
        : <ul className="workflow-detail-files">{summary.files.map((file) => <li key={file.path}>
          <span>{file.from} · {file.label}</span>
          {onOpenFile
            ? <TextLink mono className="truncate" data-hint={`打开 ${file.path}`} onClick={() => onOpenFile(file.path)}>{shortPath(file.path)}</TextLink>
            : <code data-hint={file.path}>{shortPath(file.path)}</code>}
        </li>)}</ul>}
    </section>
  </div>;
}
