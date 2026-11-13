/**
 * 工作流详情（AAW 面板第二层）：它是什么、长什么样、在本项目跑过哪些。
 *
 * - 头部：名称、来源（预置 / 我的）、版本；动作：运行、复制为我的、删除；
 * - 流程图：按起点显示整张图（只读，点节点看它会做什么、什么时候执行）；
 * - 源码：工作流目录里的文件（只读）与编译诊断；
 * - 运行：本项目里用这个工作流发起的运行。
 *
 * 启动表单在本页顶部展开（WorkflowLauncher）。
 */
import { ExecutorSettings } from "./ExecutorSettings.tsx";
import { RunManager } from "./RunManager.tsx";
import { errorLine } from "../status/errorText.ts";
import { useEffect, useRef, useState } from "react";
import { GraphCanvas, ZoomTools } from "./GraphCanvas.tsx";
import type { WorkflowDraft, WorkflowExecutors, RunSummary, WorkflowDetail, WorkflowFileTransfer, WorkflowService } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { BAND_MAX, WorkflowHierarchy } from "./WorkflowHierarchy.tsx";
import { NodeDetail } from "./NodeDetail.tsx";
import { entryConditions } from "./nodeDetail.ts";
import { WorkflowLauncher } from "./WorkflowLauncher.tsx";

type Tab = "graph" | "source" | "runs" | "executors";

export function WorkflowDetailView({ service, id, launch, pickFiles, transfer, executors, draft, onAiEdit, onOpenDraft, onLaunch, onCloseLaunch, onStarted, onOpenRun, onCopied, onDeleted }: {
  service: WorkflowService;
  id: string;
  runs: readonly RunSummary[];
  /** 非空时在顶部展开启动表单（可预选起点）。 */
  launch: { readonly entry?: string } | null;
  pickFiles?: () => Promise<readonly string[]>;
  /** 导出用的保存对话框（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  /** 这个工作流未保存的 AI 修改（ADR 036）。 */
  draft?: WorkflowDraft;
  /** 让 AI 修改：由面板先问要求，或回到已有草稿。preset 表示要先复制。 */
  onAiEdit?: (preset: boolean) => void;
  onOpenDraft?: (draftId: string) => void;
  /** 按角色指定 Agent 和模型（ADR 036）。 */
  executors?: WorkflowExecutors;
  onLaunch: (entry?: string) => void;
  onCloseLaunch: () => void;
  onStarted: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onCopied: (id: string) => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("graph");
  const [entry, setEntry] = useState("");
  const [selected, setSelected] = useState("");
  const [selectedPhase, setSelectedPhase] = useState<string | undefined>();
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState("");
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 面板按工作流 id 重新挂载本组件（key），这里只管首次读取。
    let live = true;
    service.workflow(id)
      .then((loaded) => {
        if (!live) return;
        setDetail(loaded);
        setEntry(loaded.meta?.entries[0]?.id ?? "");
        setFile(loaded.files.find((f) => f.path === "workflow.yaml")?.path ?? loaded.files[0]?.path ?? "");
      })
      .catch((cause: unknown) => {
        if (live) setError(errorLine(cause));
      });
    return () => {
      live = false;
    };
  }, [service, id]);

  // 含已归档的：在这里也能找回和恢复。runs 变化时面板会重新渲染本页。
  const own = service.allRuns().filter((run) => run.workflowId === id);
  if (error !== "") return <div role="alert" className="workflow-error">读取工作流失败：{error}</div>;
  if (detail === null) return <div className="workflow-empty">正在读取工作流…</div>;
  const meta = detail.meta;
  const catalog = detail.catalogs[entry] ?? null;
  const node = catalog?.nodes.find((n) => n.id === selected);
  const errors = detail.diagnostics.filter((d) => d.severity === "error");
  const warnings = detail.diagnostics.filter((d) => d.severity === "warning");
  const shown = detail.files.find((f) => f.path === file);
  const untrusted = detail.scripts.filter((script) => !script.trusted);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className={`workflow-detail-page${tab === "graph" ? " is-graph" : ""}`}>
    <header className="workflow-detail-head">
      <div className="workflow-detail-title">
        <b>{meta?.name ?? detail.id}</b>
        <span className={`workflow-origin origin-${detail.origin}`}>{detail.origin === "preset" ? "预置" : "我的"}</span>
        {meta?.version && <small>{meta.version}</small>}
        {meta?.revision && <code title="源码内容标识：源码改动后会变">{meta.revision}</code>}
      </div>
      <div className="workflow-detail-actions">
        {meta && <button className="primary" onClick={() => onLaunch(entry || undefined)}>运行</button>}
        {onAiEdit && <button disabled={busy} title={detail.origin === "preset" ? "预置工作流不能直接改：先复制为我的，再让 AI 修改副本" : draft ? "回到这个工作流未保存的 AI 修改" : "让 AI 改一份草稿，确认后再保存"} onClick={() => onAiEdit(detail.origin === "preset")}>
          {detail.origin === "preset" ? "复制并用 AI 修改" : draft ? "继续 AI 修改" : "用 AI 修改"}
        </button>}
        <button disabled={busy} onClick={() => void act(async () => onCopied(await service.copyWorkflow(detail.id)))}>复制为我的</button>
        {transfer && <button disabled={busy} title="导出为一个文件，可以发给别人导入" onClick={() => void act(async () => {
          const text = await service.exportWorkflow(detail.id);
          if (await transfer.saveText(`${detail.id}.aaw-workflow.json`, text)) setNotice("已导出。");
        })}>导出</button>}
        {detail.origin === "user" && (confirmDelete
          ? <span className="workflow-confirm">删除后不能恢复，已有的运行记录保留。<button disabled={busy} onClick={() => void act(async () => { await service.deleteWorkflow(detail.id); onDeleted(); })}>确认删除</button><button onClick={() => setConfirmDelete(false)}>取消</button></span>
          : <button onClick={() => setConfirmDelete(true)}>删除</button>)}
      </div>
      {meta?.description && <p className="workflow-detail-desc">{meta.description}</p>}
    </header>

    {launch && meta && <div className="workflow-launch-sheet">
      <WorkflowLauncher
        key={`${detail.id}:${launch.entry ?? ""}`}
        service={service}
        meta={meta}
        initialEntry={launch.entry}
        pickFiles={pickFiles}
        onStarted={onStarted}
        onCancel={onCloseLaunch}
      />
    </div>}

    {notice !== "" && <p className="workflow-muted workflow-pad" role="status">{notice}</p>}

    {draft && onOpenDraft && <div className="workflow-diagnostics tone-warn" aria-label="未保存的修改">
      <b>有一份未保存的 AI 修改{draft.changes > 0 ? `（改了 ${draft.changes} 个文件${draft.ok ? "" : "，编译还没通过"}）` : "（还没有改动）"}</b>
      <button onClick={() => onOpenDraft(draft.draftId)}>打开草稿</button>
    </div>}

    {untrusted.length > 0 && <div className="workflow-diagnostics tone-warn" role="alert" aria-label="脚本信任">
      <b>这个工作流里有 {untrusted.length} 个脚本还没确认信任，确认前不能运行</b>
      <p>运行时这些脚本会在你的电脑上执行。请先查看内容，确认没有问题再信任。导入的工作流，或在应用外改过的脚本，都需要确认。</p>
      <ul>{untrusted.map((script) => <li key={script.path}>
        <button type="button" className="workflow-link" onClick={() => { setTab("source"); setFile(script.path); }}>{script.path}</button>
      </li>)}</ul>
      <button className="primary" disabled={busy} onClick={() => void act(async () => {
        await service.trustScripts(detail.id);
        setDetail(await service.workflow(detail.id));
      })}>我已查看，信任这些脚本</button>
    </div>}

    {errors.length > 0 && <div className="workflow-diagnostics tone-danger" role="alert">
      <b>源码有 {errors.length} 处错误，暂时不能运行</b>
      <ul>{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
    </div>}

    <nav className="workflow-tabs" role="tablist" aria-label="工作流详情">
      <button role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>流程图</button>
      <button role="tab" aria-selected={tab === "source"} onClick={() => setTab("source")}>源码{warnings.length > 0 ? ` · ${warnings.length} 条提醒` : ""}</button>
      <button role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>本项目的运行 · {own.length}</button>
      {executors && <button role="tab" aria-selected={tab === "executors"} onClick={() => setTab("executors")}>执行者</button>}
    </nav>

    {tab === "graph" && <div className="workflow-detail-graph">
      <div className="workflow-canvas-bar">
        {meta && meta.entries.length > 1 ? <label className="workflow-entry-picker">起点
          <select value={entry} onChange={(e) => { setEntry(e.target.value); setSelected(""); }}>
            {meta.entries.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label> : <span />}
        {catalog?.structure && catalog.entry && <span className="workflow-tools"><ZoomTools zoom={zoom} onZoom={setZoom} viewport={viewport} /></span>}
      </div>
      {catalog?.structure && catalog.entry
        ? <GraphCanvas zoom={zoom} onZoom={setZoom} label="流程图预览" className="preview" viewportRef={viewport}>
          <WorkflowHierarchy
            key={entry}
            entry={catalog.entry}
            structure={catalog.structure}
            nodes={catalog.nodes}
            stages={catalog.stages}
            snapshot={null}
            selected={selected}
            selectedPhase={selectedPhase}
            bandWidth={BAND_MAX}
            onSelect={(site, _path, phase) => { setSelected(site); setSelectedPhase(phase); }}
          />
        </GraphCanvas>
        : <div className="workflow-empty">{meta ? "这个起点没有可显示的流程结构。" : "源码修正后才能显示流程图。"}</div>}
      {node && catalog?.structure && <aside className="workflow-inspector" aria-label="节点说明">
        <div className="workflow-inspector-head">
          <b title={node.label}>{node.label}</b>
          <button className="workflow-inspector-close" onClick={() => setSelected("")} aria-label="关闭节点说明">×</button>
        </div>
        <div className="workflow-inspector-body">
          <NodeDetail
            steps={node.steps}
            conditions={entryConditions(catalog.structure, node.id, selectedPhase, (site) => catalog.nodes.find((n) => n.id === site)?.label ?? site)}
            executed={false}
            running={false}
            view={null}
            raw={undefined}
            sessionMissing={false}
          />
        </div>
      </aside>}
    </div>}

    {tab === "source" && <div className="workflow-source">
      {warnings.length > 0 && <div className="workflow-diagnostics">
        <b>提醒</b>
        <ul>{warnings.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
      </div>}
      <div className="workflow-source-body">
        <ul className="workflow-source-files" aria-label="源码文件">
          {detail.files.map((f) => <li key={f.path}><button aria-pressed={f.path === file} onClick={() => setFile(f.path)} title={f.path}>{f.path}</button></li>)}
        </ul>
        <pre className="workflow-source-text" aria-label={file}>{shown?.text ?? ""}</pre>
      </div>
      <p className="workflow-muted">源码在这里只读。{detail.origin === "preset" ? "预置工作流不能改，复制为我的之后再修改。" : "要修改，点「用 AI 修改」。"}</p>
    </div>}

    {tab === "executors" && executors && <ExecutorSettings workflowId={detail.id} catalogs={detail.catalogs} executors={executors} />}

    {tab === "runs" && (own.length === 0
      ? <p className="workflow-muted workflow-pad">本项目还没有用这个工作流发起过运行。</p>
      : <RunManager service={service} runs={own} onOpenRun={onOpenRun} />)}
  </div>;
}
