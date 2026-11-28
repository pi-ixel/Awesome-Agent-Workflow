import type { Context } from "cordis";
import { createElement, type ReactNode } from "react";
import { createStore } from "zustand";
import { MessageCircleIcon } from "../../../shared/ui/icons.tsx";
import type { SkillsService } from "../../skills/service.ts";
import type { SkillsSettingsView } from "../../skills/types.ts";
import type { GitService } from "../../git/service.ts";
import type { GitReviewNavigation } from "../../git/types.ts";
import type { ProjectExtension } from "./extension.ts";
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
import { knownWorkspacePaths } from "../workspace/knownPaths.ts";
import { registerProjectExit } from "../lifecycle/lifecycle.ts";
import { withProjectView } from "./bindings/projectView.tsx";
import { createProjectViewNavigation } from "./bindings/workbenchNavigation.ts";
import { createProjectSidebarState } from "./sidebarState.ts";
import { openAnnotation } from "../conversation/ui/openAnnotation.ts";
import type { ConversationDocumentView } from "../conversation/ui/documentView.ts";
import { projectFolderPath } from "../../../shared/panelPaths.ts";

export const name = "project-workbench";
export const inject = ["project", "workbench", "agents", "host", "diagnostics"];

export function apply(ctx: Context): void {
  const { project, workbench, agents, diagnostics } = ctx;
  const sidebar = createProjectSidebarState(ctx.host.storage);
  const gitReview = createStore<{
    query?: GitService["query"];
    open?: GitReviewNavigation["open"];
    annotationView?: GitReviewNavigation["annotationView"];
  }>(() => ({}));
  const skills = createStore<{
    readonly candidates?: SkillsService["candidates"];
    readonly resolveSlashSkills?: SkillsService["resolveSlashSkills"];
  }>(() => ({}));
  const documentView = createStore<{
    view?: ConversationDocumentView;
    openFileTree?: DocumentNavigation["openFileTree"];
  }>(() => ({}));
  /** 插件给项目界面的扩展（project:extension 绑定）；会话页、侧栏与总览共用。 */
  const extension = createStore<{ view?: ProjectExtension }>(() => ({}));
  let openAddRemoteProject: (() => void) | undefined;
  let renderEditProjectForm:
    ((path: string, onClose: () => void) => ReactNode) | undefined;
  let renderAddProjectForm: ((onClose: () => void, history?: ReactNode) => ReactNode) | undefined;
  let restoreRemoteProject: ((path: string) => Promise<boolean>) | undefined;
  let repairRemoteProject: ((path: string) => void) | undefined;
  let active = true;
  const isCurrent = () => active && project.isActive();
  const navigation = createProjectViewNavigation(workbench, project, {
    isCurrent,
    openFileTree: (path) => documentView.getState().openFileTree?.(path),
    openInFileManager: (path) => ctx.host.files.openInFileManager(path, "open-directory"),
    openAddRemoteProject: () => {
      if (!openAddRemoteProject) return false;
      openAddRemoteProject();
      return true;
    },
    renderEditProjectForm: (path, onClose) =>
      renderEditProjectForm?.(path, onClose) ?? null,
    renderAddProjectForm: (onClose, history) => renderAddProjectForm?.(onClose, history) ?? null,
    restoreRemoteProject: (path) => {
      if (!restoreRemoteProject) throw new Error("远程项目服务不可用");
      return restoreRemoteProject(path);
    },
    repairRemoteProject: (path) => repairRemoteProject?.(path),
  });
  const projectView = {
    project,
    sidebar: sidebar.snapshot,
    navigation: navigation.commands,
    gitReview,
    extension,
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
      shouldPlay: () => knownWorkspacePaths(project.projects.workspace.getState()).length > 0,
    }),
  );
  ctx.effect(() => {
    const binding = ctx.inject(["skills"], function projectSkillInputs(scoped) {
      const provider = scoped.skills;
      scoped.effect(() => {
        skills.setState({
          candidates: (names, invocations) =>
            provider.candidates(names, invocations),
          resolveSlashSkills: provider.resolveSlashSkills,
        });
        return () => skills.setState({}, true);
      });
    });
    return () => binding.dispose();
  }, "project:skill-inputs");
  ctx.effect(() => {
    const binding = ctx.inject(["git", "gitUi"], function projectGitReview(scoped) {
      const { query } = scoped.git;
      const { open, annotationView } = scoped.gitUi;
      scoped.effect(() => {
        gitReview.setState({ query, open, annotationView });
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
  ctx.effect(() => {
    const binding = ctx.inject(["remoteProjectUi"], function projectRemoteAdd(scoped) {
      const ui = scoped.remoteProjectUi;
      scoped.effect(() => {
        openAddRemoteProject = ui ? () => ui.openAddRemoteProject() : undefined;
        renderAddProjectForm = ui?.renderAddProjectForm?.bind(ui);
        restoreRemoteProject = ui?.restoreRemovedProject?.bind(ui);
        repairRemoteProject = ui?.repairRemovedProject?.bind(ui);
        renderEditProjectForm = ui?.renderEditProjectForm?.bind(ui);
        return () => {
          renderEditProjectForm = undefined;
          openAddRemoteProject = undefined;
          renderAddProjectForm = undefined;
          restoreRemoteProject = undefined;
          repairRemoteProject = undefined;
        };
      });
    });
    return () => binding.dispose();
  }, "project:remote-project-ui");
  ctx.effect(() => {
    const binding = ctx.inject(["projectExtension"], function projectExtensionView(scoped) {
      const view = scoped.projectExtension;
      scoped.effect(() => {
        extension.setState({ view });
        return () => extension.setState({ view: undefined });
      });
    });
    return () => binding.dispose();
  }, "project:extension");
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
            openAnnotation: (annotation, draft) => openAnnotation(annotationNavigation, annotation, draft),
            ownsFindShortcut: (event) => documents.fileFind.owner(event) !== null,
            fileCandidates: {
              isActive: () => documents.isActive(),
              listWorkspaceFiles: (path) => documents.listWorkspaceFiles(projectFolderPath(path)),
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
      label: "会话",
      panelLabel: "项目树",
      default: true,
      keepMounted: true,
      Icon: MessageCircleIcon,
      View: Sidebar,
      unread: {
        getCount: () => Object.values(project.sessions.activity.getState().unreadReplies)
          .filter((entry) => entry.agentId === agents.selectedId).length,
        subscribe(listener) {
          const stopActivity = project.sessions.activity.subscribe(listener);
          const stopSelection = agents.subscribeSelection(listener);
          return () => { stopActivity(); stopSelection(); };
        },
      },
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
    skills,
    gitReview,
    extension,
    documentView,
    watchActivity: project.projects.subscribeWorkspaceActivity,
    openDiagnostics: () => {
      if (projectView.isActive()) diagnostics.open();
    },
    openArchiveSettings: () => {
      workbench.navigation.getState().openSettingsTab("archive", projectView.isActive);
    },
    workbench,
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
  for (const settings of createProjectSettings(LegacyAgentData, skillsSettings, agents))
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
