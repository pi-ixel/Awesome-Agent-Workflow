import { useEffect, useState } from "react";
import { pathKey } from "../../../shared/panelPaths.ts";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { errorLine } from "../status/errorText.ts";
import { statusLabel } from "../status/snapshot.ts";
import type { WorkflowService, WorkflowSummary } from "../types.ts";
type SidebarTab = "presets" | "mine" | "runs";

const tabs = [
  { value: "presets", label: "预置" },
  { value: "mine", label: "我的" },
  { value: "runs", label: "运行" },
] satisfies readonly { value: SidebarTab; label: string }[];
const row = `flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui-sm text-ink hover:bg-hover ${focusVisibleRing}`;

export function WorkflowSidebar({ project, service, onOpenWorkflow, onOpenRun }: {
  readonly project: string;
  readonly service: WorkflowService;
  readonly onOpenWorkflow: (id: string) => void;
  readonly onOpenRun: (id: string) => void;
}) {
  const [tab, setTab] = useState<SidebarTab>("presets");
  const [items, setItems] = useState<readonly WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");
  const projectKey = pathKey(project);
  const readRuns = () =>
    pathKey(service.sessionLinks().workspace ?? "") === projectKey ? service.runs() : [];
  const [runs, setRuns] = useState(readRuns);

  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        const result = await service.workflows();
        if (!live || request !== generation) return;
        setItems(result);
        setError("");
      } catch (cause) {
        if (live && request === generation) setError(errorLine(cause));
      }
    };
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "library-changed") void load();
      if (event.type === "runs-changed")
        setRuns(pathKey(service.sessionLinks().workspace ?? "") === projectKey ? service.runs() : []);
    });
    void load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [projectKey, service]);

  const workflows = items?.filter((item) => item.origin === (tab === "presets" ? "preset" : "user"));
  const message = tab === "runs"
    ? (runs.length === 0 ? "当前项目还没有运行记录" : null)
    : (error || (workflows === undefined ? "正在读取…" : workflows.length === 0 ? "没有工作流" : null));

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 px-2 py-2" aria-label="工作流列表">
      <div className="flex min-h-9 shrink-0 items-center">
        <SegmentedControl<SidebarTab> groupLabel="工作流列表类别" value={tab} onChange={setTab} options={tabs} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {message && <p className="m-2 text-ui-sm text-ink-mute">{message}</p>}
        <ul>
          {tab === "runs"
            ? runs.map((run) => (
                <li key={run.runId}>
                  <button type="button" className={row} onClick={() => onOpenRun(run.runId)}>
                    <span className="min-w-0 flex-1 truncate">{run.title || run.name || run.runId}</span>
                    <span className="shrink-0 text-ui-xs text-ink-mute">{statusLabel(run)}</span>
                  </button>
                </li>
              ))
            : workflows?.map((workflow) => (
                <li key={workflow.id}>
                  <button type="button" className={row} onClick={() => onOpenWorkflow(workflow.id)}>
                    <span className="min-w-0 flex-1 truncate">{workflow.meta?.name ?? workflow.id}</span>
                  </button>
                </li>
              ))}
        </ul>
      </div>
    </section>
  );
}
