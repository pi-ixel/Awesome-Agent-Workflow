import { foregroundFixture } from "./foreground.ts";
import type { ReactNode } from "react";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { windowHost } from "../../src/plugins/host/window/window.ts";
import { createHostExitGate } from "../../src/plugins/host/lifecycle/exitGate.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance/appearance.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/composition/workbench.ts";
import { workspaceCommands } from "../../src/plugins/project/workspace/workspaceStore.ts";
import type { WorkspaceStoreState } from "../../src/plugins/project/workspace/types.ts";
import type { ReadonlySnapshot } from "../../src/shared/state/readonlySnapshot.ts";
import { createStore, useStore } from "zustand";
import { ProjectViewContext, type ProjectViewBinding } from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { createProjectSidebarState } from "../../src/plugins/project/ui/sidebarState.ts";
import { createProjectViewNavigation } from "../../src/plugins/project/ui/bindings/workbenchNavigation.ts";
import { desktopPanelLayouts } from "../../src/bootstrap/panelLayouts.ts";

type ProjectFixture = {
  [Key in keyof ProjectService]?: ProjectService[Key] extends object
    ? Partial<ProjectService[Key]>
    : ProjectService[Key];
};

export function createTestProjectWorkbench(project: ProjectFixture) {
  const scope = createConfigurationScope(webviewStorage, desktopSettingsKey);
  const appearance = createWorkbenchAppearance(scope);
  const workbench = new DesktopWorkbench(windowHost, appearance, webviewStorage, {
    exitGate: createHostExitGate(),
    Window: () => null,
    panelLayoutCompatibility: desktopPanelLayouts,
  });
  const sidebar = createProjectSidebarState(webviewStorage);
  const unlisten = workbench.onViewOpened(() => sidebar.snapshot.getState().closeAddPanel());
  const current = createStore<ProjectViewBinding | undefined>(() => undefined);
  let releaseCurrent: (() => void) | undefined;
  const register = (service: ProjectFixture) => {
    releaseCurrent?.();
    const workspace = service.projects?.workspace;
    const state = workspace?.getState();
    const commands = state && "selectWorkspace" in state
      ? workspaceCommands(workspace as ReadonlySnapshot<WorkspaceStoreState>)
      : undefined;
    const registeredProject = {
      isActive: () => true,
      ...service,
      projects: {
        pickDirectory: () => Promise.resolve(null),
        ...commands,
        ...service.projects,
      },
      sessions: { ...service.sessions },
      conversation: {
        foreground: foregroundFixture.view,
        ...service.conversation,
      },
      drafts: { ...service.drafts },
      interactions: { ...service.interactions },
    } as ProjectService;
    const isCurrent = (): boolean => current.getState() === binding && registeredProject.isActive();
    const navigation = createProjectViewNavigation(workbench, registeredProject, {
      isCurrent,
      openFileTree: (path) => workbench.panels.getState().tool(path, "files"),
    });
    const binding: ProjectViewBinding = {
      sidebar: sidebar.snapshot,
      project: registeredProject,
      navigation: navigation.commands,
      isActive: isCurrent,
    };
    current.setState(binding, true);
    const release = () => {
      navigation.dispose();
      if (current.getState() === binding) current.setState(undefined, true);
    };
    releaseCurrent = release;
    return release;
  };
  const release = register(project);
  function Wrapper({ children }: { readonly children: ReactNode }) {
    const binding = useStore(current);
    return (
      <WorkbenchContext.Provider value={workbench}>
        <ProjectViewContext.Provider value={binding}>
          {children}
        </ProjectViewContext.Provider>
      </WorkbenchContext.Provider>
    );
  }
  return {
    workbench,
    sidebar: sidebar.store,
    Wrapper,
    release,
    register,
    dispose() {
      releaseCurrent?.();
      unlisten();
      sidebar.dispose();
      workbench.dispose();
      appearance.dispose();
      scope.dispose();
    },
  };
}
