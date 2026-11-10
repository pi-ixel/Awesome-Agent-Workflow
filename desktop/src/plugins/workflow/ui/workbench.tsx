import type { Context } from "cordis";
import { createStore, useStore } from "zustand";
import type {
  WorkbenchContributions,
  WorkbenchLayout,
} from "../../workbench/types.ts";
import type { WorkflowService } from "../service.ts";
import type { WorkflowView } from "../types.ts";
import type { HostStorage } from "../../host/types.ts";
import type { ProjectSessions } from "../../project/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { WorkflowIcon } from "../../../shared/ui/icons.tsx";
import { AAW_ENTRY_DEFINITIONS, type AawEntryId } from "../launch/entryWizard.ts";
import { AawPanel, type WorkflowPanelSegment, type WorkflowSessionPicker } from "./AawPanel.tsx";
import { sendAawToTarget } from "./aawTarget.ts";
import AawStatusPanel from "./AawStatusPanel.tsx";
import type { WizardMemory } from "./EntryWizard.tsx";
import { AawTimeline } from "./timeline/AawTimeline.tsx";
import { createTimelineDrawer } from "./timeline/drawer.ts";
import { bindWorkflowWorkspace } from "../status/workspaceBinding.ts";

const panelId = "aaw";

export function createWorkflowWorkbench(
  workflow: WorkflowService,
  layout: WorkbenchLayout,
  sessions: Pick<ProjectSessions, "deliverToSession" | "isConversationVisible" | "showConversation">,
  sessionPicker: WorkflowSessionPicker,
  storage: HostStorage,
) {
  type Launch = { id: number; project: string; entry: AawEntryId };
  const launch = createStore<{ request: Launch | null }>(() => ({
    request: null,
  }));
  const drafts = new Map<string, WizardMemory>();
  const timeline = createTimelineDrawer(storage);
  let sequence = 0;
  let disposed = false;
  const active = () =>
    !disposed && workflow.isActive() && layout.navigationGuard.isActive();
  const isCurrentProject = (key: string) =>
    active() && key === pathKey(layout.navigation.getState().contextPath ?? "");
  const commands = {
    isActive: active,
    submit: workflow.submit.bind(workflow),
    status: workflow.status,
    refresh: () => workflow.refresh(),
    selectSr: (sr: string) => workflow.selectSr(sr),
    setAutoRefresh: (enabled: boolean) => workflow.setAutoRefresh(enabled),
  };
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
    segment?: WorkflowPanelSegment,
    entry?: AawEntryId,
  ) {
    const key = pathKey(project);
    if (!isCurrentProject(key)) return;
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

  const view: WorkflowView = {
    status: workflow.status,
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
    Overview: () => <AawStatusPanel workflow={workflow} />,
    timeline: {
      View: () => <AawTimeline statusSource={workflow.status} drawer={timeline} />,
      isExpanded: timeline.isExpanded,
    },
  };
  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      label: "AAW 工作流",
      description: "查看进度与启动工作流",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (project) => show(project),
    },
    View: function WorkflowPanelView({ project, visible }) {
      const request = useStore(launch, (state) => state.request);
      const key = pathKey(project);
      const segment = useStore(layout.panels, (state) =>
        state.projects[key]?.toolViews?.[panelId] === "launch" ? "launch" : "progress",
      );
      return (
        <AawPanel
          project={project}
          visible={visible}
          workflow={commands}
          sessionPicker={sessionPicker}
          segment={segment}
          onSelectSegment={(next) => {
            if (isCurrentProject(key)) layout.panels.getState().setToolView(project, panelId, next);
          }}
          isConversationVisible={() => sessions.isConversationVisible(project)}
          onViewSession={() => {
            if (!isCurrentProject(key)) return;
            sessions.showConversation(project);
            layout.panels.getState().collapse(project);
          }}
          sendToTarget={(target, prompt) =>
            sendAawToTarget(sessions, commands, project, target, prompt)
          }
          drafts={drafts}
          launch={request?.project === key ? request : null}
        />
      );
    },
  };
  return {
    view,
    panel,
    dispose() {
      disposed = true;
      unlisten();
      launch.setState({ request: null });
      drafts.clear();
      timeline.dispose();
    },
  };
}

export const name = "workflow-workbench";
export const inject = ["workflow", "project", "workbench", "host"];

export function apply(ctx: Context): void {
  const { workflow, workbench, project } = ctx;
  const { session } = project.conversation.foreground;
  const { workspace } = project.projects;
  const ui = createWorkflowWorkbench(workflow, workbench, project.sessions, {
    sessions: session,
    current() {
      const state = session.getState();
      return {
        path: workspace.getState().activePath,
        sessionId: state.activeSessionId,
        switching: state.openingSessionId !== null || state.isConnecting,
        bound: state.isBound,
      };
    },
  }, ctx.host.storage);
  ctx.provide("workflowUi", ui.view);
  ctx.effect(() => () => ui.dispose(), "workflow:workbench-resources");
  ctx.effect(() => {
    const binding = bindWorkflowWorkspace(workflow, workspace, {
      isActive: () => workbench.navigationGuard.isActive(),
      getPath: () => workbench.navigation.getState().contextPath,
      subscribe: workbench.navigation.subscribe,
    });
    const skills = ctx.inject(["skills"], function workflowSkillSource(scoped) {
      scoped.effect(() => binding.attachSkillSource(scoped.skills.source));
    });
    return async () => {
      binding.dispose();
      await skills.dispose();
    };
  }, "workflow:workbench-workspace");
  ctx.effect(() => workbench.register("panels", ui.panel));
}
