/**
 * AI 编辑工作流的草稿页（ADR 036）。
 *
 * - 没有编辑会话时：写下想怎么改，开一个工作目录指向草稿的会话；
 * - 有会话时：打开会话，或把编译报错转给 AI；
 * - 每隔几秒重新编译草稿：报错（文件、行号、原因）、改了哪些文件与逐行差异、改动前后的流程图；
 * - 保存前编译必须通过；放弃要再确认一次。
 */
import { useEffect, useRef, useState } from "react";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import type { WorkflowCatalog, WorkflowDraftCheck, WorkflowDraftEditor, WorkflowService } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { errorLine } from "../status/errorText.ts";
import { draftPrompt } from "../editing/draftSessions.ts";
import { BAND_MAX, WorkflowHierarchy } from "./WorkflowHierarchy.tsx";
import { diffLines, withContext } from "./textDiff.ts";
import { Badge, Listbox } from "../../../shared/ui/controls.tsx";
import { primaryButton, secondaryButton } from "./buttons.ts";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { settingsTextareaClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";

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

  if (check === null) return error !== "" ? <Callout tone="danger" className="workflow-callout" title={error} /> : <div className="workflow-empty">正在读取草稿…</div>;

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
        <Badge tone={check.ok ? "ok" : "danger"}>{check.ok ? "编译通过" : `${errors.length} 处错误`}</Badge>
      </div>
      <div className="workflow-detail-actions">
        <button type="button" className={primaryButton} disabled={busy || !canSave} data-hint={!check.ok ? "编译通过后才能保存" : canSave ? "" : "还没有改动"} onClick={() => void act(async () => {
          await editor?.end(draftId);
          onSaved(await service.saveDraft(draftId));
        })}>保存</button>
        {confirmDiscard
          ? <InlineConfirm label="确认放弃" message="放弃后草稿里的改动全部丢掉。" confirmLabel="放弃" busy={busy} onConfirm={() => void act(async () => {
            await editor?.end(draftId);
            await service.discardDraft(draftId);
            onDiscarded();
          })} onCancel={() => setConfirmDiscard(false)} />
          : <button type="button" className={secondaryButton} onClick={() => setConfirmDiscard(true)}>放弃</button>}
      </div>
      <p className="workflow-detail-desc">{hasSession
        ? "在中间的编辑会话里告诉 AI 要怎么改；这里随时显示编译结果和改动，看过、编译通过后再保存。"
        : "AI 改的是一份草稿，原工作流不受影响。看过改动、编译通过后再保存。"}</p>
    </header>

    {error !== "" && <Callout tone="danger" className="workflow-callout" title={error} onDismiss={() => setError("")} />}

    {editor && (hasSession
      ? <p className="workflow-muted workflow-draft-hint">在中间的编辑会话里继续和 AI 说要怎么改。<TextLink onClick={() => void act(async () => { await editor.show(draftId); })}>回到编辑会话</TextLink></p>
      : <div className="workflow-draft-session" role="group" aria-label="继续编辑">
        <label>{check.changes.length > 0 ? "编辑会话已经结束（例如界面重载过）。告诉 AI 接着怎么改：" : "告诉 AI 你想怎么改："}
          <textarea className={settingsTextareaClass} rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={base === null ? "例如：做一个先写设计、再评审、最后实现的流程" : "例如：在设计评审之后加一个人工确认"} />
        </label>
        <button type="button" className={primaryButton} disabled={busy || request.trim() === ""} onClick={startSession}>{check.changes.length > 0 ? "继续编辑" : "开始编辑"}</button>
      </div>)}

    {errors.length > 0 && <Callout tone="danger" className="workflow-callout" label="编译报错" title={`源码有 ${errors.length} 处错误，修正后才能保存`}>
      <ul className="workflow-callout-list">{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
      {hasSession && <p className="workflow-muted">AI 会用 check_workflow 工具自己检查并修正，这里同步显示结果。</p>}
    </Callout>}
    {warnings.length > 0 && <Callout tone="info" role="note" className="workflow-callout" title="提醒">
      <ul className="workflow-callout-list">{warnings.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
    </Callout>}

    <div className="workflow-tabs">
      <SegmentedControl<Tab>
        tabs
        groupLabel="草稿"
        value={tab}
        onChange={setTab}
        options={[{ value: "changes", label: `改动 · ${check.changes.length}` }, { value: "graph", label: "流程图对比" }]}
      />
    </div>

    {tab === "changes" && (check.changes.length === 0
      ? <p className="workflow-muted workflow-pad">{base === null ? "这是新建的工作流，还没开始改。" : "还没有改动。"}</p>
      : <div className="workflow-source-body">
        <ul className="workflow-source-files" aria-label="改动的文件">
          {check.changes.map((c) => <li key={c.path}><button aria-pressed={c.path === changed?.path} onClick={() => setFile(c.path)} data-hint={c.path}>
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
      {entries.length > 1 && <div className="workflow-entry-picker">起点
        <Listbox
          label="起点"
          value={shownEntry}
          options={entries.map((id) => ({ value: id, label: check.meta?.entries.find((item) => item.id === id)?.label ?? id }))}
          onChange={setEntry}
        />
      </div>}
      {/* 新建的工作流没有「改动前」：只放一张满宽的图。 */}
      {base === null
        ? <GraphPane title="流程图" catalog={after} empty={check.ok ? "这个起点没有可显示的流程结构。" : "编译通过后才能显示流程图。"} />
        : <div className="workflow-draft-compare">
          <GraphPane title="改动前" catalog={previous} empty="原工作流没有这个起点。" />
          <GraphPane title="改动后" catalog={after} empty={check.ok ? "这个起点没有可显示的流程结构。" : "编译通过后才能显示流程图。"} />
        </div>}
    </div>}
  </div>;
}

function GraphPane({ title, catalog, empty }: { title: string; catalog: WorkflowCatalog | null; empty: string }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement | null>(null);
  const graph = catalog?.structure && catalog.entry ? catalog : null;
  return <section aria-label={title} className="workflow-draft-pane">
    <div className="workflow-canvas-bar">
      <h4>{title}</h4>
    </div>
    {graph?.structure && graph.entry
      ? <GraphCanvas zoom={zoom} onZoom={setZoom} label={`${title}的流程图`} className="preview" viewportRef={viewport}>
        <WorkflowHierarchy entry={graph.entry} structure={graph.structure} nodes={graph.nodes} stages={graph.stages} snapshot={null} selected="" bandWidth={BAND_MAX} onSelect={() => {}} />
      </GraphCanvas>
      : <p className="workflow-muted">{empty}</p>}
  </section>;
}
