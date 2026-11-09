import type { Context } from "cordis";
import { createStore, useStore } from "zustand";
import type {
  WorkbenchContributions,
  WorkbenchLayout,
} from "../../contracts/workbench.ts";
import type { WorkflowService } from "../../contracts/workflow.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import { WorkflowIcon } from "../../shared/ui/icons.tsx";
import { AAW_ENTRY_DEFINITIONS, type AawEntryId } from "./entryWizard.ts";
import { AawPanel } from "./ui/AawPanel.tsx";
import AawStatusPanel from "./ui/AawStatusPanel.tsx";
import type { WizardMemory } from "./ui/EntryWizard.tsx";
import { AawTimeline } from "./ui/timeline/AawTimeline.tsx";
import { bindWorkflowWorkspace } from "./workspaceBinding.ts";

const panelId = "aaw";

export function createWorkflowWorkbench(
  workflow: WorkflowService,
  layout: WorkbenchLayout,
) {
  type Launch = { id: number; project: string; entry: AawEntryId };
  const launch = createStore<{ request: Launch | null }>(() => ({
    request: null,
  }));
  const drafts = new Map<string, WizardMemory>();
  let sequence = 0;
  let disposed = false;
  const active = () =>
    !disposed && workflow.isActive() && layout.navigationGuard.isActive();
  const commands = { isActive: active, submit: workflow.submit.bind(workflow) };
  const unlisten = layout.navigation.subscribe(() => {
    const request = launch.getState().request;
    if (
      request &&
      pathKey(layout.navigation.getState().contextPath ?? "") !==
        request.project
    )
      launch.setState({ request: null });
  });

  function show(
    project: string,
    segment?: "launch" | "progress",
    entry?: AawEntryId,
  ) {
    if (!active()) return;
    const key = pathKey(project);
    if (key !== pathKey(layout.navigation.getState().contextPath ?? "")) return;
    const resume = () => show(project, segment, entry);
    const panel = layout.panels.getState();
    const previous = panel.projects[key];
    if (previous?.active !== panelId && !layout.navigationGuard.guard(resume))
      return;
    if (entry)
      launch.setState({ request: { id: ++sequence, project: key, entry } });
    if (segment) panel.setToolView(project, panelId, segment);
    panel.tool(project, panelId);
  }

  const contribution: WorkbenchContributions["workflow"] = {
    id: "workflow",
    service: workflow,
    entries: AAW_ENTRY_DEFINITIONS.map(({ id: entry, title }) => ({
      id: `wizard-${entry}`,
      label: entry,
      description: `${title}：打开向导并定位到入口表单`,
      run() {
        const project = layout.navigation.getState().contextPath;
        if (project) show(project, "launch", entry);
      },
    })),
    openProgress: (project) => show(project, "progress"),
  };
  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      tool: panelId,
      label: "AAW 工作流",
      description: "查看进度与启动工作流",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (project) => show(project),
    },
    View: function WorkflowPanelView({ project, visible }) {
      const request = useStore(launch, (state) => state.request);
      return (
        <AawPanel
          project={project}
          visible={visible}
          workflow={commands}
          drafts={drafts}
          launch={request?.project === pathKey(project) ? request : null}
        />
      );
    },
  };
  return {
    contribution,
    panel,
    dispose() {
      disposed = true;
      unlisten();
      launch.setState({ request: null });
      drafts.clear();
    },
  };
}

export const name = "workflow-workbench";
export const inject = ["workflow", "project", "workbench"];

export function apply(ctx: Context): void {
  const { workflow, workbench } = ctx;
  const ui = createWorkflowWorkbench(workflow, workbench);
  ctx.effect(() => () => ui.dispose(), "workflow:workbench-resources");
  ctx.effect(
    () => bindWorkflowWorkspace(workflow, ctx.project.workspace, workbench),
    "workflow:workbench-workspace",
  );
  ctx.effect(() => workbench.register("workflow", ui.contribution));
  ctx.effect(() => workbench.register("panels", ui.panel));
  ctx.effect(() =>
    workbench.register("chrome", {
      id: "workflow-overview",
      View: AawStatusPanel,
    }),
  );
  ctx.effect(() =>
    workbench.register("chrome", {
      id: "workflow-timeline",
      View: AawTimeline,
    }),
  );
}
