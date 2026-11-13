/**
 * 运行管理（ADR 036，B3）：搜索、按状态筛选、显示已归档；每条运行可以改标题、归档或恢复、删除。
 * 进行中的运行不能归档或删除；删除要再确认一次，删除后不能恢复。
 */
import { useState } from "react";
import type { RunSummary, WorkflowService } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { errorLine } from "../status/errorText.ts";
import { formatAgo, useNow } from "./time.ts";
import { matchesRun } from "./runSearch.ts";

const FILTERS: readonly { readonly id: string; readonly label: string; readonly match: (run: RunSummary) => boolean }[] = [
  { id: "all", label: "全部状态", match: () => true },
  { id: "running", label: "进行中", match: (run) => run.status === "running" },
  { id: "waiting", label: "等你确认", match: (run) => run.status === "waiting" },
  { id: "completed", label: "已完成", match: (run) => run.status === "completed" },
  { id: "failed", label: "失败", match: (run) => run.status === "failed" },
  { id: "stopped", label: "已停止", match: (run) => run.status === "stopped" },
];

export function RunManager({ service, runs, onOpenRun }: {
  service: Pick<WorkflowService, "renameRun" | "archiveRun" | "deleteRun">;
  /** 要管理的运行（含已归档的），最近在前。 */
  runs: readonly RunSummary[];
  onOpenRun: (runId: string) => void;
}) {
  const now = useNow();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ runId: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const match = FILTERS.find((item) => item.id === filter)?.match ?? (() => true);
  const archivedCount = runs.filter((run) => run.archivedAt != null).length;
  const shown = runs.filter((run) => (showArchived || run.archivedAt == null) && match(run) && matchesRun(run, query));

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className="workflow-run-manager">
    <div className="workflow-run-filters">
      <input type="search" aria-label="搜索运行" placeholder="搜索标题、工作流或需求" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="按状态筛选" value={filter} onChange={(event) => setFilter(event.target.value)}>
        {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <label className="workflow-check">
        <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
        <span>显示已归档{archivedCount > 0 ? `（${archivedCount}）` : ""}</span>
      </label>
    </div>
    {error !== "" && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    {shown.length === 0
      ? <p className="workflow-muted">{runs.length === 0 ? "还没有运行。" : "没有符合条件的运行。"}</p>
      : <ul className="workflow-run-list">{shown.map((run) => {
        const active = run.status === "running";
        const archived = run.archivedAt != null;
        return <li key={run.runId} className={archived ? "is-archived" : undefined}>
          {editing?.runId === run.runId
            ? <form className="workflow-run-rename" onSubmit={(event) => {
              event.preventDefault();
              const title = editing.title;
              void act(async () => { await service.renameRun(run.runId, title); setEditing(null); });
            }}>
              <input aria-label="运行标题" value={editing.title} autoFocus onChange={(event) => setEditing({ runId: run.runId, title: event.target.value })} />
              <button type="submit" className="primary" disabled={busy || editing.title.trim() === ""}>保存</button>
              <button type="button" onClick={() => setEditing(null)}>取消</button>
            </form>
            : <button type="button" onClick={() => onOpenRun(run.runId)} aria-label={`查看运行 ${run.title}`}>
              <span className="workflow-run-list-title" title={run.title}>{run.title}{archived ? "（已归档）" : ""}</span>
              <span className="workflow-run-list-meta">
                {run.name}{run.entryLabel ? ` · ${run.entryLabel}` : ""}
                {run.updatedAt != null && ` · ${formatAgo(run.updatedAt, now)}`}
              </span>
              <span className={`workflow-run-list-state status-${run.status}`}>{statusLabel(run)}</span>
            </button>}
          {deleting === run.runId
            ? <span className="workflow-run-actions" role="group" aria-label="确认删除">
              <span>永久删除这次运行的记录？删除后不能恢复，项目里的文件不受影响。</span>
              <button className="danger" disabled={busy} onClick={() => void act(async () => { await service.deleteRun(run.runId); setDeleting(""); })}>删除</button>
              <button onClick={() => setDeleting("")}>取消</button>
            </span>
            : editing?.runId !== run.runId && <span className="workflow-run-actions">
              <button disabled={busy} onClick={() => setEditing({ runId: run.runId, title: run.title })}>改标题</button>
              <button disabled={busy || active} title={active ? "运行停下后才能归档" : undefined} onClick={() => void act(() => service.archiveRun(run.runId, !archived))}>{archived ? "恢复" : "归档"}</button>
              <button disabled={busy || active} title={active ? "运行停下后才能删除" : undefined} onClick={() => setDeleting(run.runId)}>删除</button>
            </span>}
        </li>;
      })}</ul>}
  </div>;
}
