/**
 * 运行管理（ADR 036，B3）：搜索、按状态筛选、显示已归档；每条运行行尾直接给出改标题、归档或恢复、删除三个图标。
 * 进行中的运行不能归档或删除；归档和删除都防误触：点一下变「确认」再点一次。恢复不丢东西，直接生效。
 *
 * 范围可切到「全部项目」（B4）：按项目分组，有运行在进行的项目排在前面；
 * 点别的项目的运行直接切到那个项目打开。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectRunSummary, RunManagerFilters, RunSummary, WorkflowService } from "../types.ts";
import { errorLine } from "../status/errorText.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { useNow } from "./time.ts";
import { DEFAULT_RUN_FILTERS, groupByProject, matchesRun } from "./runSearch.ts";
import { ActionButton, Listbox, MultiListbox } from "../../../shared/ui/controls.tsx";
import { settingsInputClass } from "../../../shared/ui/SettingsPageParts.tsx";

import { attentionOf, ordinalOf } from "./runList.ts";
import { RunMarkLegend, RunRow } from "./RunList.tsx";
import { RUN_MARK_OPTIONS, runMarkKind } from "./runMarks.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { ConfirmIconAction } from "../../../shared/ui/ConfirmIconAction.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, SearchIcon, TrashIcon } from "../../../shared/ui/icons.tsx";


/** 全部项目时多久刷新一次（别的项目的事件不推到这里）。 */
const ALL_PROJECTS_REFRESH_MS = 5000;

/** 筛选行的控件统一高度与字号（搜索框、两个下拉）。 */
const FILTER_SIZE = "min-h-8 text-ui-base";
/** 行尾图标按钮。 */
const ROW_ICON = "rounded-control text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

/** 同一工作流的运行里起点不止一种时，起点名才有区分作用。 */
function entriesVary(runs: readonly RunSummary[]): ReadonlySet<string> {
  const entries = new Map<string, Set<string>>();
  for (const run of runs) {
    const key = run.workflowId || run.name;
    entries.set(key, (entries.get(key) ?? new Set()).add(run.entry || run.entryLabel));
  }
  return new Set([...entries].filter(([, set]) => set.size > 1).map(([key]) => key));
}

const projectName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function RunManager({ service, runs, onOpenRun, project, onOpenProjectRun, filters: controlledFilters, onFiltersChange }: {
  service: Pick<WorkflowService, "renameRun" | "archiveRun" | "deleteRun" | "runsAcrossProjects">;
  /** 要管理的运行（含已归档的），最近在前。 */
  runs: readonly RunSummary[];
  onOpenRun: (runId: string) => void;
  filters?: RunManagerFilters;
  onFiltersChange?: (filters: RunManagerFilters) => void;
  /** 当前项目；与 onOpenProjectRun 一起给出时可以切到「全部项目」。 */
  project?: string;
  onOpenProjectRun?: (project: string, runId: string) => void;
}) {
  const now = useNow();
  const [localFilters, setLocalFilters] = useState(DEFAULT_RUN_FILTERS);
  const filters = controlledFilters ?? localFilters;
  const updateFilters = (change: Partial<RunManagerFilters>) =>
    (onFiltersChange ?? setLocalFilters)({ ...filters, ...change });
  const { query, statuses, scope, showArchived } = filters;
  const [everywhere, setEverywhere] = useState<readonly ProjectRunSummary[] | null>(null);
  const [editing, setEditing] = useState<{ runId: string; title: string } | null>(null);
  /** 正在确认的行尾操作：`archive:<runId>` 或 `delete:<runId>`，同一时间只有一个。 */
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const crossProject = project !== undefined && onOpenProjectRun !== undefined;
  const all = crossProject && scope === "all";

  const reload = async () => {
    try {
      setEverywhere(await service.runsAcrossProjects());
    } catch (cause) {
      setError(errorLine(cause));
    }
  };
  // 切到全部项目时读一次，之后定时刷新；runs 变化（当前项目有事件）时也重读。
  useEffect(() => {
    if (!all) return;
    let alive = true;
    const load = () => service.runsAcrossProjects().then(
      (list) => { if (alive) setEverywhere(list); },
      (cause: unknown) => { if (alive) setError(errorLine(cause)); },
    );
    void load();
    const timer = setInterval(() => void load(), ALL_PROJECTS_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [all, runs, service]);

  const match = (run: RunSummary) => statuses.length === 0 || statuses.includes(runMarkKind(run));
  const source: readonly RunSummary[] = all ? everywhere ?? [] : runs;
  const archivedCount = source.filter((run) => run.archivedAt != null).length;
  const visible = (run: RunSummary) => (showArchived || run.archivedAt == null) && match(run) && matchesRun(run, query);
  const shown = source.filter(visible);
  const pendingIds = new Set(attentionOf(shown.filter((run) => run.archivedAt == null)).map((run) => run.runId));
  const ordinals = all ? {} : ordinalOf(runs);
  const varied = entriesVary(source);
  const isHere = (path: string | undefined) => path === undefined || (project !== undefined && pathKey(path) === pathKey(project));

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      if (all) await reload();
    } catch (cause) {
      setError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  };

  const row = (run: RunSummary, workflowName: string, path?: string, unassigned = false) => {
    const active = run.status === "running";
    const archived = run.archivedAt != null;
    // 当前项目的运行不带项目参数（服务用当前项目）；别的项目的带上它所属的项目。
    const where = isHere(path) ? undefined : path;
    const renaming = editing?.runId === run.runId;
    const archiveLabel = archived ? "恢复" : "归档";
    /** 要确认的操作：点一下变「确认」；进行中时图标留在原位变灰，悬停说明原因（外层承接悬停，禁用的按钮收不到）。 */
    const guarded = (kind: string, label: string, icon: ReactNode, work: () => Promise<void>) => active || busy
      ? <span {...hintTooltipProps(active ? `停下后才能${label}` : label)}>
        <IconButton iconSize="compact" className={ROW_ICON} aria-label={label} disabled>{icon}</IconButton>
      </span>
      : <ConfirmIconAction label={label} icon={icon}
        confirming={confirming === `${kind}:${run.runId}`}
        setConfirming={(value) => setConfirming(value ? `${kind}:${run.runId}` : "")}
        onConfirm={() => void act(work)} />;
    return <li key={run.runId} className={archived ? "is-archived" : undefined}>
      {renaming
        ? <form className="workflow-run-rename" onSubmit={(event) => {
          event.preventDefault();
          const title = editing.title;
          void act(async () => { await service.renameRun(run.runId, title, where); setEditing(null); });
        }}>
          <input className={settingsInputClass} aria-label="运行标题" value={editing.title} autoFocus onChange={(event) => setEditing({ runId: run.runId, title: event.target.value })} />
          <ActionButton type="submit" tone="primary" size="compact" disabled={busy || editing.title.trim() === ""}>保存</ActionButton>
          <ActionButton type="button" tone="ghost" size="compact" onClick={() => setEditing(null)}>取消</ActionButton>
        </form>
        : <RunRow
          run={run}
          now={now}
          ordinal={ordinals[run.runId]}
          workflowName={workflowName}
          showEntry={varied.has(run.workflowId || run.name)}
          suffix={unassigned ? "（待关联项目）" : archived ? "（已归档）" : ""}
          onOpen={() => unassigned || where === undefined ? onOpenRun(run.runId) : onOpenProjectRun?.(where, run.runId)}
        />}
      {!unassigned && !renaming && <div className="workflow-run-tools">
        <IconButton iconSize="compact" className={ROW_ICON} aria-label="改标题" {...hintTooltipProps("改标题")} disabled={busy}
          onClick={() => setEditing({ runId: run.runId, title: run.title })}><PencilIcon className="ui-icon-14" /></IconButton>
        {archived
          ? <IconButton iconSize="compact" className={ROW_ICON} aria-label={archiveLabel} {...hintTooltipProps(archiveLabel)} disabled={busy}
            onClick={() => void act(() => service.archiveRun(run.runId, false, where))}><ArchiveRestoreIcon className="ui-icon-14" /></IconButton>
          : guarded("archive", "归档", <ArchiveIcon className="ui-icon-14" />, () => service.archiveRun(run.runId, true, where))}
        {guarded("delete", "删除", <TrashIcon className="ui-icon-14" />, () => service.deleteRun(run.runId, where))}
      </div>}
    </li>;
  };

  const renderRuns = (pending: boolean) => {
    const inSection = (run: RunSummary) => pendingIds.has(run.runId) === pending;
    if (all) {
      return groupByProject((everywhere ?? []).filter((run) => visible(run) && inSection(run))).map((group) =>
        <section key={pathKey(group.project)} className="workflow-run-group" aria-label={projectName(group.project)}>
          <h4 data-hint={group.project}>{projectName(group.project)}{isHere(group.project) && <small>当前项目</small>}</h4>
          <ul className="workflow-run-list">{group.runs.map((run) => row(run, run.name, group.project, run.unassigned))}</ul>
        </section>);
    }
    const section = shown.filter(inSection);
    return <ul className="workflow-run-list">{section.map((run, index) => {
      const previous = section[index - 1];
      const workflowName = previous && (previous.workflowId || previous.name) === (run.workflowId || run.name) ? "" : run.name;
      return row(run, workflowName);
    })}</ul>;
  };

  return <div className="workflow-run-manager">
    <div className="workflow-run-filters">
      <label className="workflow-run-search">
        <SearchIcon className="ui-icon-14" aria-hidden="true" />
        <input type="search" className={`${settingsInputClass} ${FILTER_SIZE}`} style={{ paddingInlineStart: 30 }} aria-label="搜索运行" placeholder="搜索标题、工作流或需求" value={query} onChange={(event) => updateFilters({ query: event.target.value })} />
      </label>
      {crossProject && <Listbox
        label="范围"
        className={FILTER_SIZE}
        value={scope}
        options={[{ value: "project", label: "当前项目" }, { value: "all", label: "全部项目" }]}
        onChange={(value) => updateFilters({ scope: value === "all" ? "all" : "project" })}
      />}
      <MultiListbox
        label="按状态筛选"
        className={`${FILTER_SIZE} max-w-36`}
        values={statuses}
        options={RUN_MARK_OPTIONS}
        emptyLabel="全部状态"
        unit="种状态"
        onChange={(values) => updateFilters({ statuses: values })}
      />
      {/* 显示已归档：和两个下拉同高的图标开关，数字是归档了几条；窄屏时不单独占一行。 */}
      <ActionButton contentLayout="custom" tone="secondary" aria-label="显示已归档" aria-pressed={showArchived}
        {...hintTooltipProps(showArchived ? "隐藏已归档" : "显示已归档")}
        className={`min-h-8 min-w-8 shrink-0 gap-1 px-2 tabular-nums ${showArchived ? "border-ink-faint bg-raised" : "text-ink-soft"}`}
        onClick={() => updateFilters({ showArchived: !showArchived })}>
        <ArchiveIcon className="ui-icon-14" />
        {archivedCount > 0 && <span>{archivedCount}</span>}
      </ActionButton>
    </div>
    {error !== "" && <Callout tone="danger" className="workflow-callout" title={error} onDismiss={() => setError("")} />}
    {all && everywhere === null
      ? <p className="workflow-muted">正在读取…</p>
      : shown.length === 0
      ? <EmptyState title={source.length === 0 ? "还没有运行" : "没有符合条件的运行"} description={source.length === 0 ? "在项目会话中输入 / 选择工作流起点即可发起运行。" : "换个关键词，或者改一下状态筛选。"} />
      : <>
        {pendingIds.size > 0 && <section className="workflow-run-section" aria-label="待处理">
          <h3>待处理</h3>
          {renderRuns(true)}
        </section>}
        {/* 页签本身就是运行管理：只有和「待处理」并列时才需要这个小标题。 */}
        {shown.length > pendingIds.size && <section className="workflow-run-section" aria-label="运行记录">
          {pendingIds.size > 0 && <h3>运行记录</h3>}
          {renderRuns(false)}
        </section>}
      </>}
    {shown.length > 0 && <RunMarkLegend />}
  </div>;
}
