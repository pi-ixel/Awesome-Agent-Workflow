/**
 * AI 编辑工作流的草稿页（ADR 036）。
 *
 * - 没有编辑会话时：写下想怎么改，开一个工作目录指向草稿的会话；
 * - 有会话时：打开会话，或把编译报错转给 AI；
 * - 每隔几秒重新编译草稿：报错（文件、行号、原因）、改了哪些文件与逐行差异、改动前后的流程图；
 * - 保存前编译必须通过；放弃要再确认一次。
 */
import { useEffect, useState } from "react";
import type { WorkflowCatalog, WorkflowDraftCheck, WorkflowDraftEditor, WorkflowService } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { errorLine } from "../status/errorText.ts";
import { draftPrompt } from "../editing/draftSessions.ts";
import { BAND_MAX, WorkflowHierarchy } from "./WorkflowHierarchy.tsx";
import { diffLines, withContext } from "./textDiff.ts";

const POLL_MS = 3000;
type Tab = "changes" | "graph";

export function DraftPage({ service, editor, draftId, onSaved, onDiscarded }: {
  service: WorkflowService;
  editor?: WorkflowDraftEditor;
  draftId: string;
  onSaved: (id: string) => void;
  onDiscarded: () => void;
}) {
  const [check, setCheck] = useState<WorkflowDraftCheck | null>(null);
  const [before, setBefore] = useState<Readonly<Record<string, WorkflowCatalog>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState("");
  const [tab, setTab] = useState<Tab>("changes");
  const [file, setFile] = useState("");
  const [entry, setEntry] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [, setSessionVersion] = useState(0);

  // 定时重新编译：Agent 改文件时界面跟着变。
  useEffect(() => {
    let live = true;
    const load = () => service.checkDraft(draftId)
      .then((next) => { if (live) { setCheck(next); setError(""); } })
      .catch((cause: unknown) => { if (live) setError(errorLine(cause)); });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [service, draftId]);

  const base = check?.draft.base ?? null;
  useEffect(() => {
    if (!base) return;
    let live = true;
    service.workflow(base).then((detail) => { if (live) setBefore(detail.catalogs); }).catch(() => {});
    return () => { live = false; };
  }, [service, base]);

  if (check === null) return error !== "" ? <div role="alert" className="workflow-error">{error}</div> : <div className="workflow-empty">正在读取草稿…</div>;

  const name = check.meta?.name ?? check.draft.base ?? "新工作流";
  const errors = check.diagnostics.filter((d) => d.severity === "error");
  const warnings = check.diagnostics.filter((d) => d.severity === "warning");
  const hasSession = editor?.has(draftId) ?? false;
  const changed = check.changes.find((c) => c.path === file) ?? check.changes[0];
  const entries = Object.keys(check.catalogs);
  const shownEntry = entries.includes(entry) ? entry : entries[0] ?? "";
  const after = check.catalogs[shownEntry] ?? null;
  const previous = before[shownEntry] ?? null;
  // 没有改动就没有可保存的内容（新建时，一点没改的起步模板也不能存成工作流）。
  const canSave = check.ok && check.changes.length > 0;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await work(); } catch (cause) { setError(errorLine(cause)); } finally { setBusy(false); }
  };
  const startSession = () => void act(async () => {
    if (!editor) return;
    const kind = check.changes.length > 0 ? "continue" : base === null ? "new" : "edit";
    await editor.start(check.draft, `编辑工作流：${name}`, draftPrompt(kind, request));
    setRequest("");
    setSessionVersion((v) => v + 1);
  });

  return <div className="workflow-draft-page">
    <header className="workflow-detail-head">
      <div className="workflow-detail-title">
        <b>{base === null ? "新建" : "修改"}：{name}</b>
        <span className={`workflow-origin ${check.ok ? "origin-user" : "origin-error"}`}>{check.ok ? "编译通过" : `${errors.length} 处错误`}</span>
      </div>
      <div className="workflow-detail-actions">
        <button className="primary" disabled={busy || !canSave} title={!check.ok ? "编译通过后才能保存" : canSave ? "" : "还没有改动"} onClick={() => void act(async () => {
          await editor?.end(draftId);
          onSaved(await service.saveDraft(draftId));
        })}>保存</button>
        {confirmDiscard
          ? <span className="workflow-confirm">放弃后草稿里的改动全部丢掉。<button disabled={busy} onClick={() => void act(async () => {
            await editor?.end(draftId);
            await service.discardDraft(draftId);
            onDiscarded();
          })}>确认放弃</button><button onClick={() => setConfirmDiscard(false)}>取消</button></span>
          : <button onClick={() => setConfirmDiscard(true)}>放弃</button>}
      </div>
      <p className="workflow-detail-desc">{hasSession
        ? "在中间的编辑会话里告诉 AI 要怎么改；这里随时显示编译结果和改动，看过、编译通过后再保存。"
        : "AI 改的是一份草稿，原工作流不受影响。看过改动、编译通过后再保存。"}</p>
    </header>

    {error !== "" && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}

    {editor && (hasSession
      ? <div className="workflow-draft-session">
        <span>编辑会话在当前项目的会话列表里，在那里继续和 AI 说要怎么改。</span>
        <button onClick={() => void act(async () => { await editor.show(draftId); })}>打开编辑会话</button>
      </div>
      : <div className="workflow-draft-session" role="group" aria-label="继续编辑">
        <label>{check.changes.length > 0 ? "编辑会话已经结束（例如界面重载过）。告诉 AI 接着怎么改：" : "告诉 AI 你想怎么改："}
          <textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={base === null ? "例如：做一个先写设计、再评审、最后实现的流程" : "例如：在设计评审之后加一个人工确认"} />
        </label>
        <button className="primary" disabled={busy || request.trim() === ""} onClick={startSession}>{check.changes.length > 0 ? "继续编辑" : "开始编辑"}</button>
      </div>)}

    {errors.length > 0 && <div className="workflow-diagnostics tone-danger" role="alert" aria-label="编译报错">
      <b>源码有 {errors.length} 处错误，修正后才能保存</b>
      <ul>{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
      {hasSession && <p className="workflow-muted">AI 会用 check_workflow 工具自己检查并修正，这里同步显示结果。</p>}
    </div>}
    {warnings.length > 0 && <div className="workflow-diagnostics">
      <b>提醒</b>
      <ul>{warnings.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
    </div>}

    <nav className="workflow-tabs" role="tablist" aria-label="草稿">
      <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>改动 · {check.changes.length}</button>
      <button role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>流程图对比</button>
    </nav>

    {tab === "changes" && (check.changes.length === 0
      ? <p className="workflow-muted workflow-pad">{base === null ? "这是新建的工作流，还没开始改。" : "还没有改动。"}</p>
      : <div className="workflow-source-body">
        <ul className="workflow-source-files" aria-label="改动的文件">
          {check.changes.map((c) => <li key={c.path}><button aria-pressed={c.path === changed?.path} onClick={() => setFile(c.path)} title={c.path}>
            {c.status === "added" ? "＋ " : c.status === "removed" ? "－ " : "～ "}{c.path}
          </button></li>)}
        </ul>
        {changed && <pre className="workflow-diff" aria-label={`差异 ${changed.path}`}>
          {withContext(diffLines(changed.before ?? "", changed.after ?? "")).map((line, index) => line === null
            ? <span key={index} className="diff-gap">⋯</span>
            : <span key={index} className={`diff-${line.kind}`}>{line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}{line.text}{"\n"}</span>)}
        </pre>}
      </div>)}

    {tab === "graph" && <div className="workflow-draft-graphs">
      {entries.length > 1 && <label className="workflow-entry-picker">起点
        <select value={shownEntry} onChange={(e) => setEntry(e.target.value)}>
          {entries.map((id) => <option key={id} value={id}>{check.meta?.entries.find((item) => item.id === id)?.label ?? id}</option>)}
        </select>
      </label>}
      <div className="workflow-draft-compare">
        <GraphPane title="改动前" catalog={previous} empty={base === null ? "新建的工作流没有改动前的版本。" : "原工作流没有这个起点。"} />
        <GraphPane title="改动后" catalog={after} empty={check.ok ? "这个起点没有可显示的流程结构。" : "编译通过后才能显示流程图。"} />
      </div>
    </div>}
  </div>;
}

function GraphPane({ title, catalog, empty }: { title: string; catalog: WorkflowCatalog | null; empty: string }) {
  return <section aria-label={title} className="workflow-draft-pane">
    <h4>{title}</h4>
    {catalog?.structure && catalog.entry
      ? <div className="workflow-viewport preview"><div className="workflow-stage">
        <WorkflowHierarchy entry={catalog.entry} structure={catalog.structure} nodes={catalog.nodes} stages={catalog.stages} snapshot={null} selected="" bandWidth={BAND_MAX} onSelect={() => {}} />
      </div></div>
      : <p className="workflow-muted">{empty}</p>}
  </section>;
}
