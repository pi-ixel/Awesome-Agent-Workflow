/**
 * 工作流详情（AAW 面板第二层）：它是什么、长什么样、在本项目跑过哪些。
 *
 * - 头部：名称、来源（预置 / 我的）、版本；动作：运行、复制为我的、删除；
 * - 流程图：按起点显示整张图（只读，点节点看它会做什么、什么时候执行）；
 * - 源码：工作流目录里的文件（只读）与编译诊断；
 * - 运行：本项目里用这个工作流发起的运行。
 *
 * 点「运行」后，启动表单替换头部显示在本页最上面（WorkflowLauncher）；流程图仍在下面可看。
 */
import { ExecutorSettings } from "./ExecutorSettings.tsx";
import { RunManager } from "./RunManager.tsx";
import { errorLine } from "../status/errorText.ts";
import { useEffect, useRef, useState } from "react";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import type { WorkflowDraft, WorkflowExecutors, RunSummary, WorkflowDetail, WorkflowFileTransfer, WorkflowService } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { BAND_MAX, WorkflowHierarchy } from "./WorkflowHierarchy.tsx";
import { NodeDetail } from "./NodeDetail.tsx";
import { entryConditions } from "./nodeDetail.ts";
import { WorkflowLauncher } from "./WorkflowLauncher.tsx";
import { Badge, Listbox } from "../../../shared/ui/controls.tsx";
import { MoreMenu } from "./MoreMenu.tsx";
import { iconButton, primaryButton, secondaryButton } from "./buttons.ts";
import { XIcon } from "../../../shared/ui/icons.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";

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
  if (error !== "") return <Callout tone="danger" className="workflow-callout" title={<>读取工作流失败：{error}</>} />;
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
    {launch && meta ? <div className="workflow-launch-sheet">
      <WorkflowLauncher
        key={`${detail.id}:${launch.entry ?? ""}`}
        service={service}
        meta={meta}
        initialEntry={launch.entry}
        pickFiles={pickFiles}
        onStarted={onStarted}
        onCancel={onCloseLaunch}
      />
    </div> : <header className="workflow-detail-head">
      <div className="workflow-detail-title">
        <b>{meta?.name ?? detail.id}</b>
        <Badge tone={detail.origin === "preset" ? "info" : "neutral"}>{detail.origin === "preset" ? "预置" : "我的"}</Badge>
        {meta?.version && <small>{meta.version}</small>}
      </div>
      <div className="workflow-detail-actions">
        {meta && <button type="button" className={primaryButton} onClick={() => onLaunch(entry || undefined)}>运行</button>}
        {onAiEdit && <button type="button" className={secondaryButton} disabled={busy} data-hint={detail.origin === "preset" ? "预置工作流不能直接改：先复制为我的，再让 AI 修改副本" : draft ? "回到这个工作流未保存的 AI 修改" : "让 AI 改一份草稿，确认后再保存"} onClick={() => onAiEdit(detail.origin === "preset")}>
          {detail.origin === "preset" ? "复制并用 AI 修改" : draft ? "继续 AI 修改" : "用 AI 修改"}
        </button>}
        <MoreMenu entries={[
          { id: "copy", label: "复制为我的", disabled: busy, onSelect: () => void act(async () => onCopied(await service.copyWorkflow(detail.id))) },
          ...(transfer ? [{ id: "export", label: "导出…", disabled: busy, onSelect: () => void act(async () => {
            const text = await service.exportWorkflow(detail.id);
            if (await transfer.saveText(`${detail.id}.aaw-workflow.json`, text)) setNotice("已导出。");
          }) }] : []),
          ...(detail.origin === "user" ? [{ type: "separator" as const }, { id: "delete", label: "删除", danger: true, onSelect: () => setConfirmDelete(true) }] : []),
        ]} />
      </div>
      {confirmDelete && <InlineConfirm className="workflow-head-confirm" label="确认删除" message="删除后不能恢复，已有的运行记录保留。" confirmLabel="删除" busy={busy} onConfirm={() => void act(async () => { await service.deleteWorkflow(detail.id); onDeleted(); })} onCancel={() => setConfirmDelete(false)} />}
      {meta?.description && <p className="workflow-detail-desc">{meta.description}</p>}
    </header>}

    {notice !== "" && <p className="workflow-muted workflow-pad" role="status">{notice}</p>}

    {draft && onOpenDraft && <Callout tone="info" role="note" label="未保存的修改" className="workflow-callout"
      title={`有一份未保存的 AI 修改${draft.changes > 0 ? `（改了 ${draft.changes} 个文件${draft.ok ? "" : "，编译还没通过"}）` : "（还没有改动）"}`}
      actions={<button type="button" className={secondaryButton} onClick={() => onOpenDraft(draft.draftId)}>打开草稿</button>} />}

    {untrusted.length > 0 && <Callout tone="warn" label="脚本信任" className="workflow-callout" title={`这个工作流里有 ${untrusted.length} 个脚本还没确认信任，确认前不能运行`}>
      <p>运行时这些脚本会在你的电脑上执行。请先查看内容，确认没有问题再信任。导入的工作流，或在应用外改过的脚本，都需要确认。</p>
      <ul className="workflow-callout-list">{untrusted.map((script) => <li key={script.path}>
        <TextLink mono onClick={() => { setTab("source"); setFile(script.path); }}>{script.path}</TextLink>
      </li>)}</ul>
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void act(async () => {
        await service.trustScripts(detail.id);
        setDetail(await service.workflow(detail.id));
      })}>我已查看，信任这些脚本</button>
    </Callout>}

    {errors.length > 0 && <Callout tone="danger" className="workflow-callout" title={`源码有 ${errors.length} 处错误，暂时不能运行`}>
      <ul className="workflow-callout-list">{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
    </Callout>}

    <div className="workflow-tabs">
      <SegmentedControl<Tab>
        tabs
        groupLabel="工作流详情"
        value={tab}
        onChange={setTab}
        options={[
          { value: "graph", label: "流程图" },
          { value: "source", label: `源码${warnings.length > 0 ? ` · ${warnings.length} 条提醒` : ""}` },
          { value: "runs", label: `本项目的运行 · ${own.length}` },
          ...(executors ? [{ value: "executors" as const, label: "执行者" }] : []),
        ]}
      />
    </div>

    {tab === "graph" && <div className="workflow-detail-graph">
      {meta && meta.entries.length > 1 && <div className="workflow-canvas-bar">
        <div className="workflow-entry-picker">起点
          <Listbox
            label="起点"
            value={entry}
            options={meta.entries.map((item) => ({ value: item.id, label: item.label }))}
            onChange={(value) => { setEntry(value); setSelected(""); }}
          />
        </div>
      </div>}
      {catalog?.structure && catalog.entry
        ? <GraphCanvas zoom={zoom} onZoom={setZoom} label="流程图预览" className="preview" viewportRef={viewport}>
          <WorkflowHierarchy
            key={entry}
            rootLabel={meta?.name}
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
          <b data-hint={node.label}>{node.label}</b>
          <button type="button" className={`${iconButton} workflow-inspector-close`} onClick={() => setSelected("")} aria-label="关闭节点说明"><XIcon className="size-3.5" /></button>
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
      {warnings.length > 0 && <Callout tone="info" role="note" className="workflow-callout" title="提醒">
        <ul className="workflow-callout-list">{warnings.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
      </Callout>}
      <div className="workflow-source-body">
        <ul className="workflow-source-files" aria-label="源码文件">
          {detail.files.map((f) => <li key={f.path}><button aria-pressed={f.path === file} onClick={() => setFile(f.path)} data-hint={f.path}>{f.path}</button></li>)}
        </ul>
        <pre className="workflow-source-text" aria-label={file}>{shown?.text ?? ""}</pre>
      </div>
      <p className="workflow-muted">源码在这里只读。{detail.origin === "preset" ? "预置工作流不能改，复制为我的之后再修改。" : "要修改，点「用 AI 修改」。"}</p>
    </div>}

    {tab === "executors" && executors && <ExecutorSettings workflowId={detail.id} catalogs={detail.catalogs} executors={executors} />}

    {tab === "runs" && (own.length === 0
      ? <EmptyState title="本项目还没有用这个工作流运行过" action={meta && <button type="button" className={secondaryButton} onClick={() => onLaunch(entry || undefined)}>运行</button>} />
      : <RunManager service={service} runs={own} onOpenRun={onOpenRun} />)}
  </div>;
}
