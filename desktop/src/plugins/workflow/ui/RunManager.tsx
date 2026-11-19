/**
 * 运行管理（ADR 036，B3）：搜索、按状态筛选、显示已归档；每条运行可以改标题、归档或恢复、删除。
 * 进行中的运行不能归档或删除；删除要再确认一次，删除后不能恢复。
 *
 * 范围可切到「全部项目」（B4）：按项目分组，有运行在进行的项目排在前面；
 * 点别的项目的运行直接切到那个项目打开。
 */
import { useEffect, useState } from "react";
import type { ProjectRunSummary, RunManagerFilters, RunSummary, WorkflowService } from "../types.ts";
import { errorLine } from "../status/errorText.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { useNow } from "./time.ts";
import { DEFAULT_RUN_FILTERS, groupByProject, matchesRun } from "./runSearch.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import { CheckSquare, Listbox } from "../../../shared/ui/controls.tsx";
import { settingsInputClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { ghostButton, primaryButton } from "./buttons.ts";
import { attentionOf, ordinalOf } from "./runList.ts";
import { RunRow } from "./RunList.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";
import { EmptyState } from "../../../shared/ui/EmptyState.tsx";

const FILTERS: readonly { readonly id: string; readonly label: string; readonly match: (run: RunSummary) => boolean }[] = [
  { id: "all", label: "全部状态", match: () => true },
  { id: "running", label: "进行中", match: (run) => run.status === "running" },
  { id: "waiting", label: "等你确认", match: (run) => run.status === "waiting" },
  { id: "completed", label: "已完成", match: (run) => run.status === "completed" },
  { id: "failed", label: "失败", match: (run) => run.status === "failed" },
  { id: "stopped", label: "已停止", match: (run) => run.status === "stopped" },
];

/** 全部项目时多久刷新一次（别的项目的事件不推到这里）。 */
const ALL_PROJECTS_REFRESH_MS = 5000;

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
  const { query, status, scope, showArchived } = filters;
  const [everywhere, setEverywhere] = useState<readonly ProjectRunSummary[] | null>(null);
  const [editing, setEditing] = useState<{ runId: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState("");
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

  const match = FILTERS.find((item) => item.id === status)?.match ?? (() => true);
  const source: readonly RunSummary[] = all ? everywhere ?? [] : runs;
  const archivedCount = source.filter((run) => run.archivedAt != null).length;
  const visible = (run: RunSummary) => (showArchived || run.archivedAt == null) && match(run) && matchesRun(run, query);
  const shown = source.filter(visible);
  const pendingIds = new Set(attentionOf(shown.filter((run) => run.archivedAt == null)).map((run) => run.runId));
  const ordinals = all ? {} : ordinalOf(runs);
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

  const row = (run: RunSummary, workflowName: string, path?: string) => {
    const active = run.status === "running";
    const archived = run.archivedAt != null;
    // 当前项目的运行不带项目参数（服务用当前项目）；别的项目的带上它所属的项目。
    const where = isHere(path) ? undefined : path;
    return <li key={run.runId} className={archived ? "is-archived" : undefined}>
      {editing?.runId === run.runId
        ? <form className="workflow-run-rename" onSubmit={(event) => {
          event.preventDefault();
          const title = editing.title;
          void act(async () => { await service.renameRun(run.runId, title, where); setEditing(null); });
        }}>
          <input className={settingsInputClass} aria-label="运行标题" value={editing.title} autoFocus onChange={(event) => setEditing({ runId: run.runId, title: event.target.value })} />
          <button type="submit" className={primaryButton} disabled={busy || editing.title.trim() === ""}>保存</button>
          <button type="button" className={ghostButton} onClick={() => setEditing(null)}>取消</button>
        </form>
        : <RunRow
          run={run}
          now={now}
          ordinal={ordinals[run.runId]}
          workflowName={workflowName}
          suffix={archived ? "（已归档）" : ""}
          onOpen={() => where === undefined ? onOpenRun(run.runId) : onOpenProjectRun?.(where, run.runId)}
        />}
      {deleting === run.runId
        ? <InlineConfirm className="workflow-run-actions" label="确认删除" message="永久删除这次运行的记录？删除后不能恢复，项目里的文件不受影响。" confirmLabel="删除" busy={busy} onConfirm={() => void act(async () => { await service.deleteRun(run.runId, where); setDeleting(""); })} onCancel={() => setDeleting("")} />
        : editing?.runId !== run.runId && <MoreMenu label={`${run.title} 的操作`} entries={[
          { id: "rename", label: "改标题", disabled: busy, onSelect: () => setEditing({ runId: run.runId, title: run.title }) },
          { id: "archive", label: archived ? "恢复" : active ? "归档（停下后可用）" : "归档", disabled: busy || active, onSelect: () => void act(() => service.archiveRun(run.runId, !archived, where)) },
          { type: "separator" },
          { id: "delete", label: active ? "删除（停下后可用）" : "删除", danger: true, disabled: busy || active, onSelect: () => setDeleting(run.runId) },
        ]} />}
    </li>;
  };

  const renderRuns = (pending: boolean) => {
    const inSection = (run: RunSummary) => pendingIds.has(run.runId) === pending;
    if (all) {
      return groupByProject((everywhere ?? []).filter((run) => visible(run) && inSection(run))).map((group) =>
        <section key={pathKey(group.project)} className="workflow-run-group" aria-label={projectName(group.project)}>
          <h4 data-hint={group.project}>{projectName(group.project)}{isHere(group.project) && <small>当前项目</small>}</h4>
          <ul className="workflow-run-list">{group.runs.map((run) => row(run, run.name, group.project))}</ul>
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
      <input type="search" className={settingsInputClass} aria-label="搜索运行" placeholder="搜索标题、工作流或需求" value={query} onChange={(event) => updateFilters({ query: event.target.value })} />
      {crossProject && <Listbox
        label="范围"
        value={scope}
        options={[{ value: "project", label: "当前项目" }, { value: "all", label: "全部项目" }]}
        onChange={(value) => updateFilters({ scope: value === "all" ? "all" : "project" })}
      />}
      <Listbox
        label="按状态筛选"
        value={status}
        options={FILTERS.map((item) => ({ value: item.id, label: item.label }))}
        onChange={(value) => updateFilters({ status: value })}
      />
    </div>
    <label className="workflow-check workflow-show-archived">
      <input type="checkbox" className="peer sr-only" checked={showArchived} onChange={(event) => updateFilters({ showArchived: event.target.checked })} />
      <CheckSquare checked={showArchived} />
      <span>显示已归档{archivedCount > 0 ? `（${archivedCount}）` : ""}</span>
    </label>
    {error !== "" && <Callout tone="danger" className="workflow-callout" title={error} onDismiss={() => setError("")} />}
    {all && everywhere === null
      ? <p className="workflow-muted">正在读取…</p>
      : shown.length === 0
      ? <EmptyState title={source.length === 0 ? "还没有运行" : "没有符合条件的运行"} description={source.length === 0 ? "在工作流库里选一个工作流，点「运行」。" : "换个关键词，或者改一下状态筛选。"} />
      : <>
        {pendingIds.size > 0 && <section className="workflow-run-section" aria-label="待处理">
          <h3>待处理</h3>
          {renderRuns(true)}
        </section>}
        {shown.length > pendingIds.size && <section className="workflow-run-section" aria-label="运行记录">
          <h3>运行记录</h3>
          {renderRuns(false)}
        </section>}
      </>}
  </div>;
}
