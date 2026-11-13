/**
 * 项目总览里的工作流区块：本项目进行中与最近的运行，以及启动入口。
 * 用 Desktop 通用样式（tailwind token），不依赖 AAW 面板的样式表。
 */
import { useEffect, useState } from "react";
import type { RunSummary, WorkflowService } from "../types.ts";
import { statusLabel } from "../status/snapshot.ts";
import { formatAgo, useNow } from "./time.ts";

export function WorkflowOverview({ service, project, onOpenRun, onLaunch, onBrowse }: {
  service: WorkflowService;
  project: string;
  onOpenRun: (runId: string) => void;
  onLaunch: () => void;
  onBrowse: () => void;
}) {
  const runs = useRuns(service);
  const own = runs.slice(0, 5);
  const now = useNow();
  return (
    <section aria-label="AAW 工作流" data-project={project} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">AAW 工作流</h2>
        <span className="text-xs text-ink-faint">
          {runs.length === 0 ? "本项目还没有运行" : `本项目共 ${runs.length} 次运行`}
        </span>
        <button type="button" onClick={onBrowse} className="ml-auto rounded px-2 py-1 text-xs text-ink-soft hover:bg-raised">工作流库</button>
        <button type="button" onClick={onLaunch} className="rounded border border-line-strong px-3 py-1 text-xs text-ink hover:bg-raised">启动工作流</button>
      </div>
      {own.length > 0 && (
        <ul className="flex flex-col">
          {own.map((run: RunSummary) => (
            <li key={run.runId}>
              <button
                type="button"
                onClick={() => onOpenRun(run.runId)}
                aria-label={`查看运行 ${run.title}`}
                className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-raised"
              >
                <span className="min-w-0 flex-1 truncate text-ink" title={run.title}>{run.title}</span>
                <span className="shrink-0 truncate text-xs text-ink-faint">
                  {run.name}{run.updatedAt != null ? ` · ${formatAgo(run.updatedAt, now)}` : ""}
                </span>
                <span className={`shrink-0 text-xs ${run.status === "running" ? "text-info" : run.status === "failed" ? "text-danger-ink" : run.status === "completed" ? "text-ok-ink" : "text-ink-soft"}`}>
                  {statusLabel(run)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 当前项目的运行列表（随服务事件刷新）。 */
function useRuns(service: WorkflowService): readonly RunSummary[] {
  const [runs, setRuns] = useState<readonly RunSummary[]>(() => service.runs());
  useEffect(() => {
    return service.subscribe((event) => {
      if (event.type === "runs-changed") setRuns(service.runs());
    });
  }, [service]);
  return runs;
}
