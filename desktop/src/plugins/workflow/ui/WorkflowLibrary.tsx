/**
 * 工作流库（AAW 面板第一层）：预置工作流、我的工作流、本项目运行三个页签。
 *
 * 工作流是模板，运行是它在本项目里的一次执行。卡片的第三行说「上次跑成什么
 * 样、多久前」，按钮跟着状态走（运行 / 继续 / 重新运行）——打开一屏就知道
 * 有没有事要做，不用逐张点进去。
 */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useState } from "react";
import type { WorkflowDraft, RunSummary, WorkflowFileTransfer, WorkflowImportPreview, WorkflowService, WorkflowSummary } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { describeDiagnostic } from "../status/library.ts";
import { formatAgo, useNow } from "./time.ts";
import { ghostButton, primaryButton, secondaryButton } from "./buttons.ts";
import { Badge, StatusDot } from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { runTone } from "./nodeText.ts";
import { attentionOf, ordinalOf } from "./runList.ts";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";
import { PageHeader } from "../../../shared/ui/PageHeader.tsx";
import { RunList } from "./RunList.tsx";

/** 页签里最多列几条运行；其余在「查看全部」。 */
const RECENT_LIMIT = 5;

export type LibraryTab = "presets" | "mine" | "runs";

export function WorkflowLibrary({ service, runs, version, hint, transfer, drafts, tab: controlledTab, onTabChange, onNewWithAi, onOpenWorkflow, onLaunch, onOpenRun, onOpenAllRuns, onOpenDraft, onDiscardDraft }: {
  service: WorkflowService;
  /** 当前项目的运行（最近在前，不含已归档）。 */
  runs: readonly RunSummary[];
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
  const attention = attentionOf(runs);
  const recent = runs.filter((run) => !attention.some((item) => item.runId === run.runId)).slice(0, RECENT_LIMIT);
  // 编号按当前项目的全部运行算一次：列表分两段（待处理 / 其余）时序号才连续。
  const ordinals = ordinalOf(runs);
  const totalRuns = service.allRuns().length;
  const now = useNow();

  return <div className="workflow-library">
    <PageHeader
      title="工作流库"
      description="工作流是流程模板；点进一张卡片看流程图与源码，点「运行」开始一次执行。"
      className="workflow-page-head"
      actions={<>
        {onNewWithAi && <button type="button" className={secondaryButton} onClick={onNewWithAi}>用 AI 新建</button>}
        {transfer && <button type="button" className={secondaryButton} onClick={() => void pickImport()}>导入…</button>}
      </>}
    />
    {hint && <Callout tone="info" role="status" title={hint} />}
    {error !== "" && <Callout tone="danger" className="workflow-callout" title={<>读取工作流库失败：{error}</>} />}
    {importError !== "" && <Callout tone="danger" className="workflow-callout" title={importError} onDismiss={() => setImportError("")} />}
    {importing && <ImportPreviewCard preview={importing.preview} busy={busy} onConfirm={() => void confirmImport()} onCancel={() => setImporting(null)} />}

    <div className="workflow-tabs">
      <SegmentedControl<LibraryTab>
        tabs
        groupLabel="工作流库"
        value={tab}
        onChange={setTab}
        options={[
          { value: "presets", label: `预置 ${presets.length}` },
          { value: "mine", label: `我的 ${mine.length}`, dot: (drafts?.length ?? 0) > 0 },
          { value: "runs", label: `运行 ${runs.length}`, dot: attention.length > 0 },
        ]}
      />
    </div>

    {tab === "presets" && <section aria-label="预置工作流" className="workflow-tab-panel">
      {items === null && error === "" && <p className="workflow-muted">正在读取…</p>}
      {items !== null && presets.length === 0 && <EmptyState title="库里没有预置工作流" description="可以从「我的」页签导入一个，或者用 AI 新建。" />}
      <div className="workflow-cards">
        {presets.map((item) => <WorkflowCard key={item.id} item={item} runs={runs} now={now} onOpen={onOpenWorkflow} onLaunch={onLaunch} onOpenRun={onOpenRun} />)}
      </div>
    </section>}

    {tab === "mine" && <section aria-label="我的工作流" className="workflow-tab-panel">
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
              ? <InlineConfirm className="workflow-row-confirm" label="确认放弃" message="放弃后改动全部丢掉。" confirmLabel="放弃" onConfirm={() => void onDiscardDraft?.(draft.draftId).finally(() => setDiscarding(""))} onCancel={() => setDiscarding("")} />
              : onDiscardDraft && <button type="button" className={ghostButton} onClick={() => setDiscarding(draft.draftId)}>放弃</button>}
          </li>;
        })}
      </ul>}
      {items !== null && mine.length === 0 && <EmptyState title="还没有自己的工作流" description="打开一个预置工作流点「复制为我的」，或者点上面的「用 AI 新建」。" />}
      <div className="workflow-cards">
        {mine.map((item) => <WorkflowCard key={item.id} item={item} runs={runs} now={now} drafted={drafts?.some((draft) => draft.base === item.id)} onOpen={onOpenWorkflow} onLaunch={onLaunch} onOpenRun={onOpenRun} />)}
      </div>
    </section>}

    {tab === "runs" && <section aria-label="运行" className="workflow-tab-panel">
      {attention.length > 0 && <AttentionCallout runs={attention} now={now} onOpenRun={onOpenRun} />}
      {runs.length === 0 && <EmptyState title="这个项目还没有运行过" description="到「预置」页签选一个工作流，点「运行」开始第一次。" action={presets.length > 0 ? <button type="button" className={secondaryButton} onClick={() => setTab("presets")}>去预置工作流</button> : undefined} />}
      {attention.length > 0 && <RunList runs={attention} now={now} groupWorkflow quiet ordinals={ordinals} onOpenRun={onOpenRun} />}
      {recent.length > 0 && <RunList runs={recent} now={now} groupWorkflow quiet ordinals={ordinals} onOpenRun={onOpenRun} />}
      {runs.length > 0 && <p className="workflow-list-more">
        {runs.length > recent.length + attention.length ? `最近 ${recent.length + attention.length} 条 · ` : ""}
        {onOpenAllRuns && <TextLink onClick={onOpenAllRuns}>{`查看全部 ${totalRuns} 次`} →</TextLink>}
        {!onOpenAllRuns && <span>共 {totalRuns} 次运行</span>}
      </p>}
    </section>}
  </div>;
}

/** 「要你处理」的提示条：一句人话 + 最近那一条 + 一个蓝色主按钮。 */
function AttentionCallout({ runs, now, onOpenRun }: {
  runs: readonly RunSummary[];
  now: number;
  onOpenRun: (runId: string) => void;
}) {
  const latest = runs[0];
  if (!latest) return null;
  const allWaiting = runs.every((run) => run.status === "waiting");
  return <Callout
    tone="warn"
    role="status"
    label="要你处理的运行"
    title={allWaiting ? `${runs.length} 次运行等你确认` : `${runs.length} 次运行要你处理`}
    actions={<button type="button" className={primaryButton} onClick={() => onOpenRun(latest.runId)}>去处理</button>}
  >
    {latest.title}
    {latest.entryLabel && ` · ${latest.entryLabel}`}
    {latest.updatedAt != null && ` · ${formatAgo(latest.updatedAt, now)}更新`}
    {runs.length > 1 && <span className="workflow-muted">（这里先列最近的一条，其余在下面的列表里）</span>}
  </Callout>;
}

function WorkflowCard({ item, runs, now, drafted, onOpen, onLaunch, onOpenRun }: {
  item: WorkflowSummary;
  runs: readonly RunSummary[];
  now: number;
  /** 有未保存的 AI 修改（ADR 036）。 */
  drafted?: boolean;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const meta = item.meta;
  const own = runs.filter((run) => run.workflowId === item.id);
  const last = own[0];
  const firstError = item.diagnostics.find((d) => d.severity === "error");
  const description = meta ? meta.description || "没有说明。" : "";
  const label = last ? statusLabel(last) : "";
  const blocked = label.startsWith("已阻塞");
  const action = !last ? "运行"
    : last.status === "waiting" || last.status === "running" ? "继续"
    : last.status === "failed" || last.status === "stopped" ? "重新运行"
    : "运行";
  return <article className={`workflow-card-item${meta ? "" : " broken"}`}>
    <button type="button" className="workflow-card-main" onClick={() => onOpen(item.id)} aria-label={`查看工作流 ${meta?.name ?? item.id}`}>
      <span className="workflow-card-name">
        <b>{meta?.name ?? item.id}</b>
        {drafted && <Badge tone="warn">有未保存的修改</Badge>}
      </span>
      {meta
        ? <span className="workflow-card-desc" data-hint={description}>{description}</span>
        : <span className="workflow-card-desc attention">源码有错误，暂时不能运行{firstError ? `：${describeDiagnostic(firstError)}` : ""}</span>}
    </button>
    <div className="workflow-card-foot">
      {meta && (last
        ? <span className="workflow-card-last" data-hint={`本项目运行过 ${own.length} 次`}>
          <StatusDot tone={runTone(last.status, blocked)} />
          上次 {label}{last.updatedAt != null && ` · ${formatAgo(last.updatedAt, now)}`}
        </span>
        : <span className="workflow-card-last" data-hint="本项目还没有这次工作流的运行记录">
          <StatusDot />
          还没运行过
        </span>)}
      {meta && <button
        type="button"
        className={`${secondaryButton} workflow-card-run`}
        onClick={() => action === "继续" && last ? onOpenRun(last.runId) : onLaunch(item.id)}
      >{action}</button>}
    </div>
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
