import type { Context } from "cordis";
import { createElement } from "react";
import { createStore } from "zustand";
import type { SkillsService } from "../../skills/service.ts";
import type { SkillsSettingsView } from "../../skills/types.ts";
import type { GitService } from "../../git/service.ts";
import type { GitReviewNavigation } from "../../git/types.ts";
import type { WorkflowView } from "../../workflow/types.ts";
import type { DocumentNavigation } from "../../documents/service.ts";
import {
  createProjectSidebar,
  createProjectPages,
  projectOverlay,
  ProjectExitDetails,
} from "./workbenchViews.tsx";
import { NewSessionHeaderAction, projectHeaders } from "./projectHeaders.tsx";
import { createProjectSettings } from "./settings.tsx";
import { createUsageSettingsEntry } from "../usage/settingsEntry.ts";
import { createLegacyAgentDataView } from "./LegacyAgentDataSection.tsx";
import { captureProjectStartup } from "./startup.ts";
import { registerProjectExit } from "../lifecycle/lifecycle.ts";
import { withProjectView } from "./bindings/projectView.tsx";
import { createProjectViewNavigation } from "./bindings/workbenchNavigation.ts";
import { createProjectSidebarState } from "./sidebarState.ts";
import { openAnnotation } from "../conversation/ui/openAnnotation.ts";
import type { ConversationDocumentView } from "../conversation/ui/documentView.ts";

export const name = "project-workbench";
export const inject = ["project", "workbench", "agents", "host", "diagnostics"];

export function apply(ctx: Context): void {
  const { project, workbench, agents, diagnostics } = ctx;
  const sidebar = createProjectSidebarState(ctx.host.storage);
  const gitReview = createStore<{
    query?: GitService["query"];
    open?: GitReviewNavigation["open"];
  }>(() => ({}));
  const skills = createStore<{
    readonly readSource?: () => string;
    readonly candidates?: SkillsService["candidates"];
  }>(() => ({}));
  const readSkillSource = () => skills.getState().readSource?.() ?? "";
  const documentView = createStore<{
    view?: ConversationDocumentView;
    openFileTree?: DocumentNavigation["openFileTree"];
  }>(() => ({}));
  let active = true;
  const isCurrent = () => active && project.isActive();
  const navigation = createProjectViewNavigation(workbench, project, {
    isCurrent,
    readSkillSource,
    openFileTree: (path) => documentView.getState().openFileTree?.(path),
  });
  const projectView = {
    project,
    sidebar: sidebar.snapshot,
    navigation: navigation.commands,
    gitReview,
    isActive: isCurrent,
  };
  ctx.effect(() => () => {
    active = false;
    navigation.dispose();
  }, "project:workbench-view");
  ctx.effect(() => () => sidebar.dispose(), "project:sidebar-state");
  ctx.effect(
    () => workbench.onViewOpened(() => sidebar.snapshot.getState().closeAddPanel()),
    "project:sidebar-navigation",
  );
  ctx.effect(() =>
    workbench.register("startup", {
      id: "project-preloading",
      capture: () => captureProjectStartup({
        workspace: project.projects.workspace,
        catalog: project.sessions.catalog,
        selection: agents.configuration,
      }),
    }),
  );
  ctx.effect(() => {
    const binding = ctx.inject(["skills"], function projectSkillInputs(scoped) {
      const provider = scoped.skills;
      scoped.effect(() => {
        skills.setState({
          readSource: provider.source.getSnapshot,
          candidates: (names, invocations) => provider.candidates(names, invocations),
        });
        return () => skills.setState({}, true);
      });
    });
    return () => binding.dispose();
  }, "project:skill-inputs");
  ctx.effect(() => {
    const binding = ctx.inject(["git", "gitUi"], function projectGitReview(scoped) {
      const { query } = scoped.git;
      const { open } = scoped.gitUi;
      scoped.effect(() => {
        gitReview.setState({ query, open });
        return () => gitReview.setState({}, true);
      });
    });
    return () => binding.dispose();
  }, "project:git-review");
  const skillsSettings = createStore<{ view?: SkillsSettingsView }>(() => ({}));
  ctx.effect(() => {
    const binding = ctx.inject(["skillsUi"], function projectSkillsSettings(scoped) {
      const view = scoped.skillsUi;
      scoped.effect(() => {
        skillsSettings.setState({ view });
        return () => skillsSettings.setState({ view: undefined });
      });
    });
    return () => binding.dispose();
  }, "project:skills-settings");
  const workflowUi = createStore<{ view?: WorkflowView }>(() => ({}));
  ctx.effect(() => {
    const binding = ctx.inject(["workflowUi"], function projectWorkflowView(scoped) {
      const view = scoped.workflowUi;
      scoped.effect(() => {
        workflowUi.setState({ view });
        return () => workflowUi.setState({ view: undefined });
      });
    });
    return () => binding.dispose();
  }, "project:workflow-view");
  ctx.effect(() => {
    const binding = ctx.inject(["documents", "documentsUi"], function projectDocumentView(scoped) {
      const { documents, documentsUi } = scoped;
      scoped.effect(() => {
        let active = true;
        const isCurrent = () => active && projectView.isActive();
        const annotationNavigation = {
          layout: workbench,
          documents,
          openFileTree: documentsUi.openFileTree,
          currentTarget: project.drafts.annotationEditor.current,
          isCurrent,
        };
        documentView.setState({
          openFileTree: documentsUi.openFileTree,
          view: {
            assetUrl: documents.assetUrl,
            openPath: (path, target, line) =>
              documentsUi.openPath(path, target, line, isCurrent),
            openAnnotation: (annotation, draft) => openAnnotation(annotationNavigation, annotation, draft),
            ownsFindShortcut: (event) => documents.fileFind.owner(event) !== null,
            fileCandidates: {
              isActive: () => documents.isActive(),
              listWorkspaceFiles: (path) => documents.listWorkspaceFiles(path),
            },
          },
        });
        return () => {
          active = false;
          documentView.setState({}, true);
        };
      });
    });
    return () => binding.dispose();
  }, "project:document-view");
  const Sidebar = withProjectView(createProjectSidebar(project), projectView);
  ctx.effect(() =>
    workbench.register("sidebar", {
      id: "project-tree",
      label: "项目树",
      View: Sidebar,
    }),
  );
  for (const header of projectHeaders)
    ctx.effect(() =>
      workbench.register("headers", {
        id: header.id,
        View: withProjectView(header.View, projectView),
        Banner: header.Banner && withProjectView(header.Banner, projectView),
      }),
    );
  ctx.effect(() =>
    workbench.register("collapsedHeaderActions", {
      id: "new-session",
      View: withProjectView(NewSessionHeaderAction, projectView),
    }),
  );
  ctx.effect(() =>
    workbench.register("exitDetails", {
      id: "project-approvals",
      View: () => createElement(ProjectExitDetails, { activity: project.sessions.activity }),
    }),
  );
  for (const page of createProjectPages({
    readSkillSource,
    skills,
    gitReview,
    workflowUi,
    documentView,
    watchActivity: project.projects.subscribeWorkspaceActivity,
    openDiagnostics: () => {
      if (projectView.isActive()) diagnostics.open();
    },
    openArchiveSettings: () => {
      workbench.navigation.getState().openSettingsTab("archive", projectView.isActive);
    },
    openExternal: (url) => projectView.isActive()
      ? workbench.openExternal(url)
      : Promise.resolve(),
  }))
    ctx.effect(() =>
      workbench.register("pages", {
        ...page,
        View: withProjectView(page.View, projectView),
      }),
    );
  ctx.effect(() =>
    workbench.register("overlays", {
      ...projectOverlay,
      View: withProjectView(projectOverlay.View, projectView),
    }),
  );
  const LegacyAgentData = createLegacyAgentDataView(agents, project.projects);
  if (ctx.host.storage.managed?.available()) ctx.effect(() =>
    workbench.register("settings", createUsageSettingsEntry(
      agents.listBuiltins().filter((agent) => agent.promptUsage),
    )),
  );
  for (const settings of createProjectSettings(LegacyAgentData, skillsSettings))
    ctx.effect(() =>
      workbench.register("settings", {
        ...settings,
        View: withProjectView(settings.View, projectView),
      }),
    );
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "project",
      label: "会话与审批偏好",
      reset: () => project.preferences.reset(),
    }),
  );
  ctx.effect(() => registerProjectExit(workbench, project));
}
