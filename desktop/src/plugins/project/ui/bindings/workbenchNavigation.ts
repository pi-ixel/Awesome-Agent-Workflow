import { pathKey } from "../../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../../shared/state/readonlySnapshot.ts";
import type { WorkbenchLayout } from "../../../workbench/types.ts";
import type { ProjectService } from "../../service.ts";
import { projectOverviewPageId } from "../../workspace/pageIds.ts";
import { addProjectViaDialog } from "../addProjectFlow.ts";
import { projectPageOf } from "./projectPage.ts";

export function createProjectViewNavigation(
  layout: Pick<WorkbenchLayout, "navigation" | "navigationGuard">,
  project: Pick<ProjectService, "projects" | "sessions" | "isActive">,
  options: {
    readonly isCurrent: () => boolean;
    readonly openFileTree: (path: string) => void;
  },
) {
  const { navigation, navigationGuard } = layout;
  const page = createSnapshotView(navigation, projectPageOf);
  const isActive = () => options.isCurrent() && navigationGuard.isActive();
  const showOverview = (path: string) => {
    navigation.getState().openView(projectOverviewPageId, path, isActive);
  };
  const run = (action: () => void) => {
    if (!isActive()) return;
    navigationGuard.run(() => {
      if (isActive()) action();
    });
  };
  return {
    commands: {
      page: page.snapshot,
      addProject: () => addProjectViaDialog(project, layout, isActive),
      showOverview,
      showConversation: (path: string) => {
        if (isActive()) project.sessions.showConversation(path);
      },
      selectOverview: (path: string) => run(() => {
        project.projects.selectWorkspace(path);
        showOverview(path);
      }),
      openFiles: (path: string) => run(() => {
        project.projects.selectWorkspace(path);
        const context = navigation.getState().contextPath;
        if (pathKey(context ?? "") !== pathKey(path)) showOverview(path);
        options.openFileTree(path);
      }),
      clearContext: (path: string) => run(() => navigation.getState().clearContextIf(path)),
      async removeProject(path: string) {
        if (!isActive()) return;
        if (await project.projects.removeProject(path, isActive) && isActive())
          navigation.getState().clearContextIf(path, isActive);
      },
      expandSidebar: () => {
        const state = navigation.getState();
        if (isActive() && state.sidebarCollapsed) state.toggleSidebarCollapsed();
      },
      openSettings: () => navigation.getState().openSettingsTab("general", isActive),
    },
    dispose: () => page.dispose(),
  };
}

export type ProjectViewNavigation = ReturnType<typeof createProjectViewNavigation>["commands"];
