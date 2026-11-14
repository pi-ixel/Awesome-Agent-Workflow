/**
 * 运行管理（ADR 036，B3）：搜索、按状态筛选、显示已归档；每条运行可以改标题、归档或恢复、删除。
 * 进行中的运行不能归档或删除；删除要再确认一次，删除后不能恢复。
 *
 * 范围可切到「全部项目」（B4）：按项目分组，有运行在进行的项目排在前面；
 * 点别的项目的运行直接切到那个项目打开。
 */
import { useEffect, useState } from "react";
import type { ProjectRunSummary, RunSummary, WorkflowService } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { errorLine } from "../status/errorText.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { formatAgo, useNow } from "./time.ts";
import { groupByProject, matchesRun } from "./runSearch.ts";
import { Listbox } from "../../../shared/ui/controls.tsx";

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

export function RunManager({ service, runs, onOpenRun, project, onOpenProjectRun }: {
  service: Pick<WorkflowService, "renameRun" | "archiveRun" | "deleteRun" | "runsAcrossProjects">;
  /** 要管理的运行（含已归档的），最近在前。 */
  runs: readonly RunSummary[];
  onOpenRun: (runId: string) => void;
  /** 当前项目；与 onOpenProjectRun 一起给出时可以切到「全部项目」。 */
  project?: string;
  onOpenProjectRun?: (project: string, runId: string) => void;
}) {
  const now = useNow();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState<"project" | "all">("project");
  const [everywhere, setEverywhere] = useState<readonly ProjectRunSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
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

  const match = FILTERS.find((item) => item.id === filter)?.match ?? (() => true);
  const source: readonly RunSummary[] = all ? everywhere ?? [] : runs;
  const archivedCount = source.filter((run) => run.archivedAt != null).length;
  const visible = (run: RunSummary) => (showArchived || run.archivedAt == null) && match(run) && matchesRun(run, query);
  const shown = source.filter(visible);
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

  const row = (run: RunSummary, path?: string) => {
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
          <input aria-label="运行标题" value={editing.title} autoFocus onChange={(event) => setEditing({ runId: run.runId, title: event.target.value })} />
          <button type="submit" className="primary" disabled={busy || editing.title.trim() === ""}>保存</button>
          <button type="button" onClick={() => setEditing(null)}>取消</button>
        </form>
        : <button type="button" onClick={() => where === undefined ? onOpenRun(run.runId) : onOpenProjectRun?.(where, run.runId)} aria-label={`查看运行 ${run.title}`}>
          <span className="workflow-run-list-title" data-hint={run.title}>{run.title}{archived ? "（已归档）" : ""}</span>
          <span className="workflow-run-list-meta">
            {run.name}{run.entryLabel ? ` · ${run.entryLabel}` : ""}
            {run.updatedAt != null && ` · ${formatAgo(run.updatedAt, now)}`}
          </span>
          <span className={`workflow-run-list-state status-${run.status}`}>{statusLabel(run)}</span>
        </button>}
      {deleting === run.runId
        ? <span className="workflow-run-actions" role="group" aria-label="确认删除">
          <span>永久删除这次运行的记录？删除后不能恢复，项目里的文件不受影响。</span>
          <button className="danger" disabled={busy} onClick={() => void act(async () => { await service.deleteRun(run.runId, where); setDeleting(""); })}>删除</button>
          <button onClick={() => setDeleting("")}>取消</button>
        </span>
        : editing?.runId !== run.runId && <span className="workflow-run-actions">
          <button disabled={busy} onClick={() => setEditing({ runId: run.runId, title: run.title })}>改标题</button>
          <button disabled={busy || active} data-hint={active ? "运行停下后才能归档" : undefined} onClick={() => void act(() => service.archiveRun(run.runId, !archived, where))}>{archived ? "恢复" : "归档"}</button>
          <button disabled={busy || active} data-hint={active ? "运行停下后才能删除" : undefined} onClick={() => setDeleting(run.runId)}>删除</button>
        </span>}
    </li>;
  };

  return <div className="workflow-run-manager">
    <div className="workflow-run-filters">
      <input type="search" aria-label="搜索运行" placeholder="搜索标题、工作流或需求" value={query} onChange={(event) => setQuery(event.target.value)} />
      {crossProject && <Listbox
        label="范围"
        value={scope}
        options={[{ value: "project", label: "当前项目" }, { value: "all", label: "全部项目" }]}
        onChange={(value) => setScope(value === "all" ? "all" : "project")}
      />}
      <Listbox
        label="按状态筛选"
        value={filter}
        options={FILTERS.map((item) => ({ value: item.id, label: item.label }))}
        onChange={setFilter}
      />
      <label className="workflow-check">
        <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
        <span>显示已归档{archivedCount > 0 ? `（${archivedCount}）` : ""}</span>
      </label>
    </div>
    {error !== "" && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    {all && everywhere === null
      ? <p className="workflow-muted">正在读取…</p>
      : shown.length === 0
      ? <p className="workflow-muted">{source.length === 0 ? "还没有运行。" : "没有符合条件的运行。"}</p>
      : all
      ? groupByProject((everywhere ?? []).filter(visible)).map((group) => <section key={pathKey(group.project)} className="workflow-run-group" aria-label={projectName(group.project)}>
        <h4 data-hint={group.project}>{projectName(group.project)}{isHere(group.project) && <small>当前项目</small>}</h4>
        <ul className="workflow-run-list">{group.runs.map((run) => row(run, group.project))}</ul>
      </section>)
      : <ul className="workflow-run-list">{shown.map((run) => row(run))}</ul>}
  </div>;
}
