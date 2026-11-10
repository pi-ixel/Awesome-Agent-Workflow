import type { Context } from "cordis";
import { useSyncExternalStore, type ComponentProps } from "react";
import { createStore, useStore } from "zustand";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import type { GitService } from "../../git/service.ts";
import type { ProjectAnnotationEditor, ProjectWorkspace } from "../../project/service.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import { insidePath, pathKey } from "../../../shared/panelPaths.ts";
import { FolderOpenIcon } from "../../../shared/ui/file-icons/icons.tsx";
import type { DocumentNavigation, DocumentsService } from "../service.ts";
import { FilePreview } from "./FilePreview.tsx";
import { FileTree } from "./FileTree.tsx";
import { MarkdownDocumentDialogs } from "./MarkdownDocumentDialogs.tsx";
import { DocumentAnnotationContext } from "./annotationView.ts";
import { documentTab, presentDocumentTab, readDocumentTab } from "./documentTabs.tsx";

type GitReader = ReadonlySnapshot<{ read?: GitService["status"] }>;
type DocumentProjectView = {
  readonly annotations?: ProjectAnnotationEditor;
  readonly watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"];
};
const noSubscription = () => () => {};
const noView = () => undefined;
const fileTreeId = "files";

export function registerDocumentPaths(workbench: WorkbenchService, documents: Pick<DocumentsService, "stat">) {
  return workbench.register("pathResolvers", {
    id: "documents",
    async resolve(path, line) {
      const entry = await documents.stat(path);
      return documentTab(entry.path, entry.directory, line);
    },
  });
}

export function documentPanels(
  documents: DocumentsService,
  { panels, openExternal }: Pick<WorkbenchService, "panels" | "openExternal">,
  git?: GitReader,
  projectView?: ReadonlySnapshot<DocumentProjectView>,
): readonly WorkbenchContributions["panels"][] {
  function WorkbenchFileTree(props: ComponentProps<typeof FileTree>) {
    const latestFileTabPath = useStore(panels, (state) => {
      const tabs = state.projects[pathKey(props.root)]?.tabs;
      if (!tabs) return undefined;
      for (let index = tabs.length - 1; index >= 0; index -= 1) {
        const entry = readDocumentTab(tabs[index], "file");
        if (entry) return entry.path;
      }
      return undefined;
    });
    const gitStatus = useSyncExternalStore(
      git?.subscribe ?? noSubscription,
      git?.getState ?? noView,
    );
    const view = useSyncExternalStore(
      projectView?.subscribe ?? noSubscription,
      projectView?.getState ?? noView,
    );
    return (
      <DocumentAnnotationContext.Provider value={view?.annotations}>
        <FileTree
          {...props}
          latestFileTabPath={latestFileTabPath}
          readGitStatus={gitStatus?.read}
          watchActivity={view?.watchActivity}
          openExternal={openExternal}
        />
      </DocumentAnnotationContext.Provider>
    );
  }
  function WorkbenchFilePreview(props: ComponentProps<typeof FilePreview>) {
    const view = useSyncExternalStore(
      projectView?.subscribe ?? noSubscription,
      projectView?.getState ?? noView,
    );
    return (
      <DocumentAnnotationContext.Provider value={view?.annotations}>
        <FilePreview {...props} openExternal={openExternal} />
      </DocumentAnnotationContext.Provider>
    );
  }
  return [
    {
      id: fileTreeId,
      launcher: {
        label: "文件",
        description: "从目录中选择一个文件",
        Icon: FolderOpenIcon,
        order: -10,
      },
      key: ({ project }) => project,
      View: ({ project, openPath }) => (
        <WorkbenchFileTree
          documents={documents}
          root={project}
          onOpen={(entry) => openPath(entry.path)}
        />
      ),
    },
    {
      id: "file",
      present: presentDocumentTab,
      key: ({ tab }) => `${tab?.id ?? "file"}:${readDocumentTab(tab, "file")?.line ?? 0}`,
      View: ({ project, tab, openPath }) => {
        const entry = readDocumentTab(tab, "file");
        return entry && (
          <WorkbenchFilePreview
            documents={documents}
            path={entry.path}
            line={entry.line}
            project={project}
            onOpen={openPath}
          />
        );
      },
    },
    {
      id: "directory",
      present: presentDocumentTab,
      View: ({ project, tab, openPath }) => {
        const entry = readDocumentTab(tab, "directory");
        return entry && (
          <WorkbenchFileTree
            documents={documents}
            root={entry.path}
            ownerProject={project}
            external={!insidePath(project, entry.path)}
            onOpen={(entry) => openPath(entry.path)}
          />
        );
      },
    },
  ];
}

export const name = "documents-workbench";
export const inject = ["documents", "workbench"];

export function apply(ctx: Context): void {
  const { documents, workbench } = ctx;
  let active = true;
  const isActive = () => active && documents.isActive() && workbench.navigationGuard.isActive();
  const navigation: DocumentNavigation = {
    openFileTree(project) {
      if (!isActive()) return;
      workbench.panels.getState().openTab(project, { id: fileTreeId, kind: fileTreeId }, isActive);
    },
    openPath: (project, path, line, isCurrent) =>
      isActive()
        ? workbench.openPath(project, path, line, () => isActive() && (isCurrent?.() ?? true))
        : Promise.resolve(false),
  };
  ctx.provide("documentsUi", navigation);
  ctx.effect(() => () => { active = false; }, "documents:workbench-navigation");
  const gitStatus = createStore<{ read?: GitService["status"] }>(() => ({}));
  const projectView = createStore<DocumentProjectView>(() => ({}));
  ctx.effect(() => {
    const binding = ctx.inject(["project"], function documentProjectView(scoped) {
      const { project } = scoped;
      scoped.effect(() => {
        projectView.setState({
          annotations: project.drafts.annotationEditor,
          watchActivity: project.projects.subscribeWorkspaceActivity,
        });
        return () => projectView.setState({}, true);
      });
      scoped.effect(() =>
        project.projects.registerProjectClose({
          id: "documents",
          check: (path) => documents.editor.confirm(path),
          closed: (path) => documents.releaseProject(path),
        }),
      );
    });
    return () => binding.dispose();
  }, "documents:project-view");
  ctx.effect(() => {
    const binding = ctx.inject(["git"], function documentGitStatus(scoped) {
      const git = scoped.git;
      scoped.effect(() => {
        gitStatus.setState({ read: (project) => git.status(project) });
        return () => gitStatus.setState({ read: undefined });
      });
    });
    return () => binding.dispose();
  }, "documents:git-status");
  ctx.effect(
    () => registerDocumentPaths(workbench, documents),
    "documents:workbench-paths",
  );
  ctx.effect(() => {
    if (typeof window === "undefined") return () => {};
    const confirmBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!documents.editor.unsaved().length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmBeforeUnload);
    return () =>
      window.removeEventListener("beforeunload", confirmBeforeUnload);
  }, "documents:beforeunload");
  ctx.effect(
    () =>
      workbench.navigationGuard.register({
        pending: () => documents.editor.unsaved().length > 0,
        confirm: () => documents.editor.confirm(),
        guard: (action, path) => documents.editor.guard(action, path),
      }),
    "documents:navigation-check",
  );
  for (const panel of documentPanels(documents, workbench, gitStatus, projectView))
    ctx.effect(() => workbench.register("panels", panel));
  ctx.effect(() =>
    workbench.register("overlays", {
      id: "documents-dialogs",
      scope: "window",
      View: () => <MarkdownDocumentDialogs editor={documents.editor} />,
    }),
  );
  ctx.effect(() =>
    workbench.registerExit({
      id: "documents",
      check: () => documents.editor.confirm(),
    }),
  );
}
