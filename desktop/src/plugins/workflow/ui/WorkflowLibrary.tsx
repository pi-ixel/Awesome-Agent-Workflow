/**
 * 工作流库（AAW 面板第一层）：包含预置和我的工作流。
 *
 * 库页提供模板详情、导入与发起入口。
 */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useState } from "react";
import type { WorkflowDraft, WorkflowFileTransfer, WorkflowImportPreview, WorkflowService, WorkflowSummary } from "../types.ts";
import { describeDiagnostic } from "../status/library.ts";
import { ghostButton, primaryButton, secondaryButton } from "./buttons.ts";
import { Badge } from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { ConfirmIconAction } from "../../../shared/ui/ConfirmIconAction.tsx";
import { ImportIcon, SparklesIcon, TrashIcon, TriangleAlertIcon } from "../../../shared/ui/icons.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";

export type LibraryTab = "presets" | "mine";

export function WorkflowLibrary({ service, version, hint, transfer, drafts, tab: controlledTab, onTabChange, onNewWithAi, onOpenWorkflow, onLaunch, onOpenDraft, onDiscardDraft }: {
  service: WorkflowService;
  /** 库变化（复制、删除）后递增，触发重新读取。 */
  version: number;
  /** 顶部提示（如「选择要启动的工作流」）。 */
  hint?: string;
  /** 导入用的打开对话框（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  /** 当前页签与切换：由面板持有，进详情再返回时还在原来那一页。 */
  tab?: LibraryTab;
  onTabChange?: (tab: LibraryTab) => void;
  onOpenWorkflow: (id: string) => void;
  onLaunch: (id: string) => void;
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
  /** 正在确认的删除：`draft:<id>` 或 `workflow:<id>`，同一时间只有一个。 */
  const [confirming, setConfirming] = useState("");
  const [ownTab, setOwnTab] = useState<LibraryTab>("presets");
  const tab = controlledTab ?? ownTab;
  const setTab = (next: LibraryTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
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

  const presets = items?.filter((item) => item.origin === "preset") ?? [];
  const mine = items?.filter((item) => item.origin === "user") ?? [];
  // 新建的草稿（或原工作流已不在）单独成卡；修改已有工作流的草稿标在原卡片上。
  const standalone = drafts?.filter((draft) => !draft.base || !mine.some((item) => item.id === draft.base)) ?? [];

  return <div className="workflow-library">
    {hint && <Callout tone="info" role="status" title={hint} />}
    {error !== "" && <Callout tone="danger" className="workflow-callout" title={<>读取工作流库失败：{error}</>} />}
    {importError !== "" && <Callout tone="danger" className="workflow-callout" title={importError} onDismiss={() => setImportError("")} />}
    {importing && <ImportPreviewCard preview={importing.preview} busy={busy} onConfirm={() => void confirmImport()} onCancel={() => setImporting(null)} />}

    <div className="workflow-library-tools">
      <SegmentedControl<LibraryTab>
        tabs
        groupLabel="工作流库"
        value={tab}
        onChange={setTab}
        options={[
          { value: "presets", label: `预置 ${presets.length}` },
          { value: "mine", label: `我的 ${mine.length + standalone.length}` },
        ]}
      />
      <div className="workflow-library-actions">
        {transfer && <IconButton className={`${secondaryButton} workflow-icon-only`} aria-label="导入" data-hint="导入" onClick={() => void pickImport()}><ImportIcon className="ui-icon-16" /></IconButton>}
        {onNewWithAi && <IconButton className={`${primaryButton} workflow-icon-only`} aria-label="用 AI 新建" data-hint="用 AI 新建" onClick={onNewWithAi}><SparklesIcon className="ui-icon-16" /></IconButton>}
      </div>
    </div>

    {tab === "presets" && <section aria-label="预置工作流" className="workflow-tab-panel">
      {items === null && error === "" && <p className="workflow-muted">正在读取…</p>}
      {items !== null && presets.length === 0 && <EmptyState title="库里没有预置工作流" description="可以从「我的」页签导入一个，或者用 AI 新建。" />}
      <div className="workflow-cards">
        {presets.map((item) => <WorkflowCard key={item.id} item={item} onOpen={onOpenWorkflow} onLaunch={onLaunch} />)}
      </div>
    </section>}

    {tab === "mine" && <section aria-label="我的工作流" className="workflow-tab-panel">
      {items !== null && mine.length === 0 && standalone.length === 0 && <EmptyState title="还没有自己的工作流" description="打开一个预置工作流点「复制为我的」，或者点上面的「用 AI 新建」。" />}
      <div className="workflow-cards">
        {standalone.map((draft) => <DraftCard key={draft.draftId} draft={draft}
          confirming={confirming === `draft:${draft.draftId}`}
          setConfirming={(value) => setConfirming(value ? `draft:${draft.draftId}` : "")}
          onOpen={() => onOpenDraft?.(draft.draftId)}
          onDiscard={onDiscardDraft && (() => void onDiscardDraft(draft.draftId))} />)}
        {mine.map((item) => <WorkflowCard key={item.id} item={item} draft={drafts?.find((draft) => draft.base === item.id)} onOpen={onOpenWorkflow} onLaunch={onLaunch}
          confirming={confirming === `workflow:${item.id}`}
          setConfirming={(value) => setConfirming(value ? `workflow:${item.id}` : "")}
          onDelete={() => void service.deleteWorkflow(item.id).catch((cause: unknown) => setImportError(`删除失败：${errorLine(cause)}`))} />)}
      </div>
    </section>}

  </div>;
}

/** 卡片标题行：草稿标记在最前，AI 写出错误时名称后加警告图标。 */
function CardName({ name, draft }: { name: string; draft?: WorkflowDraft }) {
  return <span className="workflow-card-name">
    {draft && <Badge>草稿</Badge>}
    <b>{name}</b>
    {draft && draft.changes > 0 && !draft.ok && <span className="workflow-card-alert" role="img" aria-label="有错误" {...hintTooltipProps("有错误")}><TriangleAlertIcon className="ui-icon-16" /></span>}
  </span>;
}

/** 卡片右上角、悬停才出现的删除（同归档会话：点一下变「确认」）；草稿和工作流卡片同一个位置。 */
function CardDelete({ label, confirming, setConfirming, onConfirm }: {
  label: string;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onConfirm: () => void;
}) {
  return <ConfirmIconAction label={label} icon={<TrashIcon className="ui-icon-16" />}
    confirming={confirming} setConfirming={setConfirming} onConfirm={onConfirm}
    className="workflow-card-delete"
    revealClassName="opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100" />;
}

/** 未保存的草稿卡片：点卡片进草稿页；垃圾桶放弃（同归档会话：点一下再确认）。 */
function DraftCard({ draft, confirming, setConfirming, onOpen, onDiscard }: {
  draft: WorkflowDraft;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onOpen: () => void;
  onDiscard?: () => void;
}) {
  const name = draft.name ?? draft.base ?? "未命名";
  return <article className={`workflow-card-item group/card${onDiscard ? " deletable" : ""}`}>
    <button type="button" className="workflow-card-main" onClick={onOpen} aria-label={`打开草稿 ${name}`}>
      <CardName name={name} draft={draft} />
      {draft.description && <span className="workflow-card-desc" data-hint={draft.description}>{draft.description}</span>}
    </button>
    {onDiscard && <CardDelete label="放弃草稿" confirming={confirming} setConfirming={setConfirming} onConfirm={onDiscard} />}
  </article>;
}

function WorkflowCard({ item, draft, onOpen, onLaunch, confirming = false, setConfirming, onDelete }: {
  item: WorkflowSummary;
  /** 这个工作流未保存的 AI 修改（ADR 036）。 */
  draft?: WorkflowDraft;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
  /** 删除（只给「我的」工作流）。 */
  confirming?: boolean;
  setConfirming?: (value: boolean) => void;
  onDelete?: () => void;
}) {
  const meta = item.meta;
  const firstError = item.diagnostics.find((d) => d.severity === "error");
  const description = meta ? meta.description || "没有说明。" : "";
  const deletable = Boolean(onDelete && setConfirming);
  return <article className={`workflow-card-item group/card${meta ? "" : " broken"}${deletable ? " deletable" : ""}`}>
    <button type="button" className="workflow-card-main" onClick={() => onOpen(item.id)} aria-label={`查看工作流 ${meta?.name ?? item.id}`}>
      <CardName name={meta?.name ?? item.id} draft={draft} />
      {meta
        ? <span className="workflow-card-desc" data-hint={description}>{description}</span>
        : <span className="workflow-card-desc attention">源码有错误，暂时不能运行{firstError ? `：${describeDiagnostic(firstError)}` : ""}</span>}
    </button>
    {onDelete && setConfirming && <CardDelete label="删除工作流" confirming={confirming} setConfirming={setConfirming} onConfirm={onDelete} />}
    {meta && <div className="workflow-template-actions">
      <button type="button" className={secondaryButton} onClick={() => onLaunch(item.id)}>运行</button>
    </div>}
  </article>;
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
      ? <Callout tone="danger" title={`源码有 ${errors.length} 处错误，不能导入`}>
        <ul className="workflow-callout-list">{errors.map((d, index) => <li key={index}>{describeDiagnostic(d)}</li>)}</ul></Callout>
      : <p className="workflow-muted">将作为「我的工作流」导入{preview.id ? `（${preview.id}）` : ""}。</p>}
    {preview.scripts.length > 0 && <Callout tone="warn" role="note" title={`包含 ${preview.scripts.length} 个脚本`}>
      <p>运行时这些脚本会在你的电脑上执行。导入后要在工作流详情里查看内容并确认信任，才能运行。</p>
      <ul className="workflow-callout-list">{preview.scripts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
    </Callout>}
    <div className="workflow-import-actions">
      <button type="button" className={primaryButton} disabled={busy || errors.length > 0} onClick={onConfirm}>导入</button>
      <button type="button" className={ghostButton} onClick={onCancel}>取消</button>
    </div>
  </div>;
}
