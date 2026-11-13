/**
 * 工作流库（AAW 面板第一层）：当前项目里进行中的运行、预置工作流与我的工作流。
 *
 * 工作流是模板，运行是它在本项目里的一次执行：卡片上写这个工作流在本项目
 * 跑过几次、最近一次是什么时候，点进去看流程图、源码和全部运行。
 */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useState } from "react";
import type { RunSummary, WorkflowService, WorkflowSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { describeDiagnostic } from "../status/library.ts";
import { formatAgo, useNow } from "./time.ts";

export function WorkflowLibrary({ service, runs, version, hint, onOpenWorkflow, onLaunch, onOpenRun }: {
  service: WorkflowService;
  /** 当前项目的运行（最近在前）。 */
  runs: readonly RunSummary[];
  /** 库变化（复制、删除）后递增，触发重新读取。 */
  version: number;
  /** 顶部提示（如「选择要启动的工作流」）。 */
  hint?: string;
  onOpenWorkflow: (id: string) => void;
  onLaunch: (id: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [items, setItems] = useState<readonly WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    service.workflows()
      .then((list) => {
        if (live) setItems(list);
      })
      .catch((cause: unknown) => {
        if (live) setError(errorLine(cause));
      });
    return () => {
      live = false;
    };
  }, [service, version]);

  const active = runs.filter((run) => run.status === "running");
  const recent = runs.filter((run) => run.status !== "running").slice(0, 5);
  const presets = items?.filter((item) => item.origin === "preset") ?? [];
  const mine = items?.filter((item) => item.origin === "user") ?? [];
  const now = useNow();

  return <div className="workflow-library">
    {hint && <p className="workflow-library-hint">{hint}</p>}
    {error !== "" && <div role="alert" className="workflow-error">读取工作流库失败：{error}</div>}
    {active.length > 0 && <section aria-label="进行中的运行">
      <h3>进行中</h3>
      <RunList runs={active} now={now} onOpenRun={onOpenRun} />
    </section>}
    <section aria-label="预置工作流">
      <h3>预置工作流</h3>
      {items === null && error === "" && <p className="workflow-muted">正在读取…</p>}
      <div className="workflow-cards">
        {presets.map((item) => <WorkflowCard key={item.id} item={item} runs={runs} now={now} onOpen={onOpenWorkflow} onLaunch={onLaunch} />)}
      </div>
    </section>
    <section aria-label="我的工作流">
      <h3>我的工作流</h3>
      {items !== null && mine.length === 0 && <p className="workflow-muted">还没有。打开一个预置工作流，点「复制为我的」，就能得到一份可以修改的副本。</p>}
      <div className="workflow-cards">
        {mine.map((item) => <WorkflowCard key={item.id} item={item} runs={runs} now={now} onOpen={onOpenWorkflow} onLaunch={onLaunch} />)}
      </div>
    </section>
    {recent.length > 0 && <section aria-label="最近的运行">
      <h3>最近的运行</h3>
      <RunList runs={recent} now={now} onOpenRun={onOpenRun} />
    </section>}
  </div>;
}

function WorkflowCard({ item, runs, now, onOpen, onLaunch }: {
  item: WorkflowSummary;
  runs: readonly RunSummary[];
  now: number;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
}) {
  const meta = item.meta;
  const own = runs.filter((run) => run.workflowId === item.id);
  const last = own[0];
  const firstError = item.diagnostics.find((d) => d.severity === "error");
  return <article className={`workflow-card-item${meta ? "" : " broken"}`}>
    <button type="button" className="workflow-card-main" onClick={() => onOpen(item.id)} aria-label={`查看工作流 ${meta?.name ?? item.id}`}>
      <span className="workflow-card-name"><b>{meta?.name ?? item.id}</b>{meta?.version && <small>{meta.version}</small>}</span>
      {meta
        ? <span className="workflow-card-desc">{meta.description || "没有说明。"}</span>
        : <span className="workflow-card-desc attention">源码有错误，暂时不能运行{firstError ? `：${describeDiagnostic(firstError)}` : ""}</span>}
      {meta && meta.entries.length > 1 && <span className="workflow-card-entries">{meta.entries.map((entry) => <i key={entry.id}>{entry.label}</i>)}</span>}
      <span className="workflow-card-foot">
        {own.length === 0 ? "本项目还没运行过" : `本项目运行过 ${own.length} 次`}
        {last?.updatedAt != null && ` · 最近 ${formatAgo(last.updatedAt, now)}`}
      </span>
    </button>
    {meta && <button type="button" className="primary" onClick={() => onLaunch(item.id)}>运行</button>}
  </article>;
}

export function RunList({ runs, now, onOpenRun }: {
  runs: readonly RunSummary[];
  now: number;
  onOpenRun: (runId: string) => void;
}) {
  return <ul className="workflow-run-list">
    {runs.map((run) => <li key={run.runId}>
      <button type="button" onClick={() => onOpenRun(run.runId)} aria-label={`查看运行 ${run.title}`}>
        <span className="workflow-run-list-title" title={run.title}>{run.title}</span>
        <span className="workflow-run-list-meta">
          {run.name}{run.entryLabel ? ` · ${run.entryLabel}` : ""}
          {run.updatedAt != null && ` · ${formatAgo(run.updatedAt, now)}`}
        </span>
        <span className={`workflow-run-list-state status-${run.status}`}>{statusLabel(run)}</span>
      </button>
    </li>)}
  </ul>;
}
