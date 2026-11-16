import { createContext, useContext, type ComponentType } from "react";
import type { ProjectService } from "../../service.ts";
import { withProjectPreferences } from "../preferencesView.tsx";
import type { ReadonlySnapshot } from "../../../../shared/state/readonlySnapshot.ts";
import type { GitReviewNavigation } from "../../../git/types.ts";
import type { WorkflowView } from "../../../workflow/types.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { emptyProjectSidebar, type ProjectSidebarState } from "../sidebarState.ts";
import type { ProjectViewNavigation } from "./workbenchNavigation.ts";
import { emptyProjectPage, type ProjectPage } from "./projectPage.ts";

export interface ProjectViewBinding {
  readonly project: ProjectService;
  readonly sidebar: ReadonlySnapshot<ProjectSidebarState>;
  readonly navigation?: ProjectViewNavigation;
  readonly gitReview?: ReadonlySnapshot<Partial<GitReviewNavigation>>;
  /** 工作流插件给总览、侧栏这类外部入口的视图（未装配时为空 store）。 */
  readonly workflowUi?: ReadonlySnapshot<{ readonly view?: WorkflowView }>;
  readonly isActive: () => boolean;
}

export const ProjectViewContext = createContext<ProjectViewBinding | undefined>(undefined);

export function useProjectView() {
  return useContext(ProjectViewContext);
}

export function useProject() {
  return useProjectView()?.project;
}

export function useProjectSidebarValue<T>(select: (state: ProjectSidebarState) => T): T {
  return useRegisteredSnapshot(useProjectView()?.sidebar, (state) => select(state ?? emptyProjectSidebar));
}

export function useProjectNavigation() {
  return useProjectView()?.navigation;
}

/** 工作流插件的外部入口（openLaunch / openRun / Overview…）；未装配时 undefined。 */
export function useWorkflowView() {
  return useProjectView()?.workflowUi;
}

export function useProjectPage() {
  return useProjectNavigation()?.page;
}

export function useProjectPageValue<T>(select: (page: ProjectPage) => T): T {
  return useRegisteredSnapshot(useProjectPage(), (page) => select(page ?? emptyProjectPage));
}

export function withProjectView<Props extends object>(
  View: ComponentType<Props>,
  binding: ProjectViewBinding,
) {
  const PreferencesView = withProjectPreferences(View, binding.project.preferences);
  return function ProjectView(props: Props) {
    return (
      <ProjectViewContext.Provider value={binding}>
        <PreferencesView {...props} />
      </ProjectViewContext.Provider>
    );
  };
}
