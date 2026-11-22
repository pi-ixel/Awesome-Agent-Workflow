import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
/**
 * 工作流详情（左侧「工作流」功能区的第二层，ADR 038）：它是什么、长什么样。
 * 运行记录归右侧的「运行管理」；发起只在会话里（「/」菜单），这里不放运行按钮。
 *
 * - 头部：名称、来源（预置 / 我的）；动作：用 AI 修改、复制为我的、导出、删除；
 * - 流程图：按起点显示整张图，点节点在分屏里审查它：做什么、交出什么、结果怎么走、要不要你确认；
 * - 源码：工作流目录里的文件（只读）与编译诊断。
 * */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import type { WorkflowCatalog, WorkflowDraft, WorkflowDetail, WorkflowFileTransfer, WorkflowService } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { FlowStages } from "./FlowStages.tsx";
import { NodeReview } from "./NodeReview.tsx";
import { KnowledgeDetail } from "./KnowledgeDetail.tsx";
import { SplitPane } from "./SplitPane.tsx";
import { entryConditions, nodeOutcomes } from "./nodeDetail.ts";
import { ActionButton, Badge, Listbox } from "../../../shared/ui/controls.tsx";
import { MoreMenu } from "./MoreMenu.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";

type Tab = "graph" | "source";

export function WorkflowDetailView({ service, id, transfer, draft, onAiEdit, onOpenDraft, onCopied, onDeleted }: {
  service: WorkflowService;
  id: string;
  /** 导出用的保存对话框（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  /** 这个工作流未保存的 AI 修改（ADR 036）。 */
  draft?: WorkflowDraft;
  /** 让 AI 修改：由面板先问要求，或回到已有草稿。preset 表示要先复制。 */
  onAiEdit?: (preset: boolean) => void;
  onOpenDraft?: (draftId: string) => void;
  onCopied: (id: string) => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("graph");
  const [entry, setEntry] = useState("");
  const [selected, setSelected] = useState("");
  const [selectedPhase, setSelectedPhase] = useState<string | undefined>();
  const [knowledge, setKnowledge] = useState("");
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState("");

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

  if (error !== "") return <Callout tone="danger" className="workflow-callout" title={<>读取工作流失败：{error}</>} />;
  if (detail === null) return <div className="workflow-empty">正在读取工作流…</div>;
  const meta = detail.meta;
  const catalog = detail.catalogs[entry] ?? null;
  const errors = detail.diagnostics.filter((d) => d.severity === "error");
  const warnings = detail.diagnostics.filter((d) => d.severity === "warning");
  const shown = detail.files.find((f) => f.path === file);
  const untrusted = detail.scripts.filter((script) => !script.trusted);

  // 选中节点的审查分屏：内容全来自定义。
  const node = catalog?.nodes.find((n) => n.id === selected);
  const labelOf = (site: string) => catalog?.nodes.find((n) => n.id === site)?.label ?? site;
  const reviewed = node && catalog?.structure ? <NodeReview
    key={`${node.id}:${selectedPhase ?? ""}`}
    node={node}
    place={placeOf(catalog, node.id, selectedPhase)}
    outcomes={nodeOutcomes(catalog.structure, node.id, selectedPhase, labelOf)}
    sources={entryConditions(catalog.structure, node.id, selectedPhase, labelOf)}
    onOpenKnowledge={setKnowledge}
    onClose={() => setSelected("")}
  /> : null;
  const knowledgeFile = knowledge ? detail.files.find((f) => f.path === `knowledge/${knowledge}`) : undefined;

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
        <Badge tone={detail.origin === "preset" ? "info" : "neutral"}>{detail.origin === "preset" ? "预置" : "我的"}</Badge>
        {meta?.version && <small>{meta.version}</small>}
      </div>
      <div className="workflow-detail-actions">
        {onAiEdit && <ActionButton type="button" tone="secondary" size="compact" disabled={busy} data-hint={detail.origin === "preset" ? "预置工作流不能直接改：先复制为我的，再让 AI 修改副本" : draft ? "回到这个工作流未保存的 AI 修改" : "让 AI 改一份草稿，确认后再保存"} onClick={() => onAiEdit(detail.origin === "preset")}>
          {detail.origin === "preset" ? "复制并用 AI 修改" : draft ? "继续 AI 修改" : "用 AI 修改"}
        </ActionButton>}
        <MoreMenu triggerRef={moreButton} entries={[
          { id: "copy", label: "复制为我的", disabled: busy, onSelect: () => void act(async () => onCopied(await service.copyWorkflow(detail.id))) },
          ...(transfer ? [{ id: "export", label: "导出…", disabled: busy, onSelect: () => void act(async () => {
            const text = await service.exportWorkflow(detail.id);
            if (await transfer.saveText(`${detail.id}.aaw-workflow.json`, text)) setNotice("已导出。");
          }) }] : []),
          ...(detail.origin === "user" ? [{ type: "separator" as const }, { id: "delete", label: "删除", danger: true, onSelect: () => setConfirmDelete(true) }] : []),
        ]} />
      </div>
      {confirmDelete && <InlineConfirm className="workflow-head-confirm" label="确认删除" message="删除后不能恢复，已有的运行记录保留。" confirmLabel="删除" busy={busy} getReturnFocus={() => moreButton.current} onConfirm={() => void act(async () => { await service.deleteWorkflow(detail.id); onDeleted(); })} onCancel={() => setConfirmDelete(false)} />}
      {meta?.description && <p className="workflow-detail-desc">{meta.description}</p>}
    </header>

    {notice !== "" && <p className="workflow-muted workflow-pad" role="status">{notice}</p>}

    {draft && onOpenDraft && <Callout tone="info" role="note" label="未保存的修改" className="workflow-callout"
      title={`有一份未保存的 AI 修改${draft.changes > 0 ? `（改了 ${draft.changes} 个文件${draft.ok ? "" : "，编译还没通过"}）` : "（还没有改动）"}`}
      actions={<ActionButton type="button" tone="secondary" size="compact" onClick={() => onOpenDraft(draft.draftId)}>打开草稿</ActionButton>} />}

    {untrusted.length > 0 && <Callout tone="warn" label="脚本信任" className="workflow-callout" title={`这个工作流里有 ${untrusted.length} 个脚本还没确认信任，确认前不能运行`}>
      <p>运行时这些脚本会在你的电脑上执行。请先查看内容，确认没有问题再信任。导入的工作流，或在应用外改过的脚本，都需要确认。</p>
      <ul className="workflow-callout-list">{untrusted.map((script) => <li key={script.path}>
        <TextLink mono onClick={() => { setTab("source"); setFile(script.path); }}>{script.path}</TextLink>
      </li>)}</ul>
      <ActionButton
        type="button"
        tone="primary"
        size="compact"
        disabled={busy}
        onClick={() => void act(async () => {
        await service.trustScripts(detail.id);
        setDetail(await service.workflow(detail.id));
      })}
      >我已查看，信任这些脚本</ActionButton>
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
      <SplitPane aside={reviewed}>
      {catalog?.structure && catalog.entry
        ? <FlowStages
          key={entry}
          label="流程图预览"
          rootLabel={meta?.name}
          entry={catalog.entry}
          structure={catalog.structure}
          nodes={catalog.nodes}
          stages={catalog.stages}
          snapshot={null}
          selected={selected}
          selectedPhase={selectedPhase}
          onSelect={(site, _path, phase) => { setSelected(site); setSelectedPhase(phase); }}
        />
        : <div className="workflow-empty">{meta ? "这个起点没有可显示的流程结构。" : "源码修正后才能显示流程图。"}</div>}
      </SplitPane>
    </div>}

    {knowledge && <KnowledgeDetail
      workflowName={meta?.name ?? detail.id}
      file={knowledge}
      text={knowledgeFile?.text ?? ""}
      onClose={() => setKnowledge("")}
    />}

    {tab === "source" && <div className="workflow-source">
      {warnings.length > 0 && <Callout tone="info" role="note" className="workflow-callout" title="提醒">
        <ul className="workflow-callout-list">{warnings.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul>
      </Callout>}
      <div className="workflow-source-body">
        <ul className="workflow-source-files" aria-label="源码文件">
          {detail.files.map((f) => (
            <li key={f.path}>
              <NavigationRow layout="tree" aria-pressed={f.path === file} onClick={() => setFile(f.path)} data-hint={f.path}>
                <span className="truncate">{f.path}</span>
              </NavigationRow>
            </li>
          ))}
        </ul>
        <pre className="workflow-source-text" aria-label={file}>{shown?.text ?? ""}</pre>
      </div>
      <p className="workflow-muted">源码在这里只读。{detail.origin === "preset" ? "预置工作流不能改，复制为我的之后再修改。" : "要修改，点「用 AI 修改」。"}</p>
    </div>}

  </div>;
}

/** 节点所在的阶段（如「02 任务」）：按阶段声明顺序编号。 */
function placeOf(catalog: WorkflowCatalog, site: string, phaseId: string | undefined): string | undefined {
  const phases = Object.values(catalog.structure?.flows ?? {}).flatMap((flow) => flow.phases);
  const phase = phaseId ? phases.find((p) => p.id === phaseId) : phases.find((p) => p.run.includes(site));
  const stages = catalog.stages ?? [];
  const index = stages.findIndex((stage) => stage.id === phase?.stage);
  return index >= 0 ? `${String(index + 1).padStart(2, "0")} ${stages[index]!.label}` : undefined;
}
