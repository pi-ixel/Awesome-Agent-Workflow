/**
 * 工作流库（AAW 面板第一层）：当前项目里进行中的运行、预置工作流与我的工作流。
 *
 * 工作流是模板，运行是它在本项目里的一次执行：卡片上写这个工作流在本项目
 * 跑过几次、最近一次是什么时候，点进去看流程图、源码和全部运行。
 */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useState } from "react";
import type { WorkflowDraft, RunSummary, WorkflowFileTransfer, WorkflowImportPreview, WorkflowService, WorkflowSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { describeDiagnostic } from "../status/library.ts";
import { formatAgo, useNow } from "./time.ts";

export function WorkflowLibrary({ service, runs, version, hint, transfer, drafts, onNewWithAi, onOpenWorkflow, onLaunch, onOpenRun, onOpenAllRuns, onOpenDraft, onDiscardDraft }: {
  service: WorkflowService;
  /** 当前项目的运行（最近在前）。 */
  runs: readonly RunSummary[];
  /** 库变化（复制、删除）后递增，触发重新读取。 */
  version: number;
  /** 顶部提示（如「选择要启动的工作流」）。 */
  hint?: string;
  /** 导入用的打开对话框（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  onOpenWorkflow: (id: string) => void;
  onLaunch: (id: string) => void;
  onOpenRun: (runId: string) => void;
  /** 打开全部运行（搜索、归档、删除）。 */
  onOpenAllRuns?: () => void;
  /** 未保存的 AI 草稿（ADR 036）；不给时不显示 AI 编辑入口。 */
  drafts?: readonly WorkflowDraft[];
  /** 让 AI 新建：由面板先问要求。 */
  onNewWithAi?: () => void;
  onOpenDraft?: (draftId: string) => void;
  onDiscardDraft?: (draftId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<readonly WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<{ text: string; preview: WorkflowImportPreview } | null>(null);
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState("");
  const pickImport = async () => {
    setImportError("");
    try {
      const text = await transfer?.openText();
      if (!text) return;
      setImporting({ text, preview: await service.importWorkflow(text, { preview: true }) });
    } catch (cause) {
      setImportError(errorLine(cause));
    }
  };
  const confirmImport = async () => {
    if (!importing) return;
    setBusy(true);
    try {
      const done = await service.importWorkflow(importing.text);
      setImporting(null);
      onOpenWorkflow(done.id);
    } catch (cause) {
      setImportError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  };
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
      <div className="workflow-section-head">
        <h3>我的工作流</h3>
        {(onNewWithAi || transfer) && <div className="workflow-section-actions">
          {onNewWithAi && <button type="button" onClick={onNewWithAi}>用 AI 新建</button>}
          {transfer && <button type="button" onClick={() => void pickImport()}>导入…</button>}
        </div>}
      </div>
      {drafts && drafts.length > 0 && <ul className="workflow-draft-list" aria-label="未保存的草稿">
        {drafts.map((draft) => {
          const base = draft.base ? items?.find((item) => item.id === draft.base)?.meta?.name ?? draft.base : null;
          const state = draft.changes === 0 ? "还没有改动" : `改了 ${draft.changes} 个文件 · ${draft.ok ? "编译通过，可以保存" : "编译还没通过"}`;
          return <li key={draft.draftId}>
            <button type="button" className="workflow-draft-open" onClick={() => onOpenDraft?.(draft.draftId)}>
              <b>{base ? `修改「${base}」` : `新建「${draft.name ?? "未命名"}」`}</b>
              <small>{state} · {formatAgo(draft.createdAt, now)}开始</small>
            </button>
            {discarding === draft.draftId
              ? <span className="workflow-confirm">放弃后改动全部丢掉。<button onClick={() => void onDiscardDraft?.(draft.draftId).finally(() => setDiscarding(""))}>确认放弃</button><button onClick={() => setDiscarding("")}>取消</button></span>
              : onDiscardDraft && <button type="button" onClick={() => setDiscarding(draft.draftId)}>放弃</button>}
          </li>;
        })}
      </ul>}
      {importError !== "" && <div role="alert" className="workflow-error">{importError}<button onClick={() => setImportError("")} aria-label="关闭提示">×</button></div>}
      {importing && <ImportPreviewCard preview={importing.preview} busy={busy} onConfirm={() => void confirmImport()} onCancel={() => setImporting(null)} />}
      {items !== null && mine.length === 0 && <p className="workflow-muted">还没有。打开一个预置工作流，点「复制为我的」，就能得到一份可以修改的副本。</p>}
      <div className="workflow-cards">
        {mine.map((item) => <WorkflowCard key={item.id} item={item} runs={runs} now={now} drafted={drafts?.some((draft) => draft.base === item.id)} onOpen={onOpenWorkflow} onLaunch={onLaunch} />)}
      </div>
    </section>
    {(recent.length > 0 || (onOpenAllRuns && service.allRuns().length > 0)) && <section aria-label="最近的运行">
      <h3>最近的运行{onOpenAllRuns && <button type="button" className="workflow-link" onClick={onOpenAllRuns}>全部运行 · {service.allRuns().length}</button>}</h3>
      {recent.length > 0 && <RunList runs={recent} now={now} onOpenRun={onOpenRun} />}
    </section>}
  </div>;
}

function WorkflowCard({ item, runs, now, drafted, onOpen, onLaunch }: {
  item: WorkflowSummary;
  runs: readonly RunSummary[];
  now: number;
  /** 有未保存的 AI 修改（ADR 036）。 */
  drafted?: boolean;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
}) {
  const meta = item.meta;
  const own = runs.filter((run) => run.workflowId === item.id);
  const last = own[0];
  const firstError = item.diagnostics.find((d) => d.severity === "error");
  return <article className={`workflow-card-item${meta ? "" : " broken"}`}>
    <button type="button" className="workflow-card-main" onClick={() => onOpen(item.id)} aria-label={`查看工作流 ${meta?.name ?? item.id}`}>
      <span className="workflow-card-name"><b>{meta?.name ?? item.id}</b>{meta?.version && <small>{meta.version}</small>}{drafted && <em className="workflow-card-badge">有未保存的修改</em>}</span>
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

/** 导入前的确认：名称、编译结果、包里的脚本（导入后要单独确认信任才能运行）。 */
function ImportPreviewCard({ preview, busy, onConfirm, onCancel }: {
  preview: WorkflowImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const errors = preview.diagnostics.filter((d) => d.severity === "error");
  return <div className="workflow-import-preview" role="group" aria-label="导入预览">
    <b>{preview.meta?.name ?? preview.id}</b>
    {preview.meta?.description && <p>{preview.meta.description}</p>}
    {errors.length > 0
      ? <div className="workflow-diagnostics tone-danger"><b>源码有 {errors.length} 处错误，不能导入</b>
        <ul>{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul></div>
      : <p className="workflow-muted">将作为「我的工作流」导入{preview.id ? `（${preview.id}）` : ""}。</p>}
    {preview.scripts.length > 0 && <div className="workflow-diagnostics tone-warn">
      <b>包含 {preview.scripts.length} 个脚本</b>
      <p>运行时这些脚本会在你的电脑上执行。导入后要在工作流详情里查看内容并确认信任，才能运行。</p>
      <ul>{preview.scripts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
    </div>}
    <div className="workflow-import-actions">
      <button className="primary" disabled={busy || errors.length > 0} onClick={onConfirm}>导入</button>
      <button onClick={onCancel}>取消</button>
    </div>
  </div>;
}

