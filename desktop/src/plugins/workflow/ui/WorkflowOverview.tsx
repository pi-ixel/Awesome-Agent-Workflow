/**
 * 项目总览里的工作流区块：本项目进行中与最近的运行，以及启动入口。
 * 运行条目与运行管理共用排版和键盘样式。
 */
import { useEffect, useState } from "react";
import type { RunSummary, WorkflowService } from "../types.ts";
import { useNow } from "./time.ts";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { RunRow } from "./RunList.tsx";

export function WorkflowOverview({
  service,
  project,
  onOpenRun,
  onLaunch,
  onBrowse,
}: {
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
    <section
      aria-label="AAW 工作流"
      data-project={project}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">AAW 工作流</h2>
        <span className="text-xs text-ink-faint">
          {runs.length === 0
            ? "本项目还没有运行"
            : `本项目共 ${runs.length} 次运行`}
        </span>
        <ActionButton
          type="button"
          onClick={onBrowse}
          tone="ghost"
          size="compact"
          className="ml-auto"
        >
          工作流库
        </ActionButton>
        <ActionButton
          type="button"
          onClick={onLaunch}
          tone="secondary"
          size="compact"
        >
          启动工作流
        </ActionButton>
      </div>
      {own.length > 0 && (
        <ul className="flex flex-col">
          {own.map((run: RunSummary) => (
            <li key={run.runId}>
              <RunRow
                run={run}
                now={now}
                workflowName={run.name}
                showEntryLabel={false}
                onOpen={() => onOpenRun(run.runId)}
              />
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
