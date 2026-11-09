import type { Context } from "cordis";
import { useMemo, type ComponentProps } from "react";
import type { WorkbenchContributions } from "../../contracts/workbench.ts";
import { insidePath } from "../../shared/panelPaths.ts";
import type { DocumentsService } from "../../contracts/documents.ts";
import { FilePreview } from "./ui/FilePreview.tsx";
import { FileTree } from "./ui/FileTree.tsx";
import { MarkdownDocumentDialogs } from "./ui/MarkdownDocumentDialogs.tsx";
import { useWorkbenchGit } from "../workbench/viewBindings.ts";

function WorkbenchFileTree(props: ComponentProps<typeof FileTree>) {
  const git = useWorkbenchGit();
  const readGitStatus = useMemo(
    () => git && ((project: string) => git.status(project)),
    [git],
  );
  return <FileTree {...props} readGitStatus={readGitStatus} />;
}

export function documentPanels(
  documents: DocumentsService,
): readonly WorkbenchContributions["panels"][] {
  return [
    {
      id: "files",
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
      key: ({ tab }) =>
        tab?.kind === "file" ? `${tab.id}:${tab.line ?? 0}` : "file",
      View: ({ project, tab, openPath }) =>
        tab?.kind === "file" && (
          <FilePreview
            documents={documents}
            path={tab.path}
            line={tab.line}
            project={project}
            onOpen={openPath}
          />
        ),
    },
    {
      id: "directory",
      View: ({ project, tab, openPath }) =>
        tab?.kind === "directory" && (
          <WorkbenchFileTree
            documents={documents}
            root={tab.path}
            ownerProject={project}
            external={!insidePath(project, tab.path)}
            onOpen={(entry) => openPath(entry.path)}
          />
        ),
    },
  ];
}

export const name = "documents-workbench";
export const inject = ["documents", "workbench", "project"];

export function apply(ctx: Context): void {
  const { documents, workbench, project } = ctx;
  ctx.effect(
    () =>
      workbench.register("documents", { id: "documents", service: documents }),
    "documents:workbench-service",
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
  for (const panel of documentPanels(documents))
    ctx.effect(() => workbench.register("panels", panel));
  ctx.effect(() =>
    workbench.register("chrome", {
      id: "documents-dialogs",
      View: () => <MarkdownDocumentDialogs editor={documents.editor} />,
    }),
  );
  ctx.effect(() =>
    workbench.registerExit({
      id: "documents",
      check: () => documents.editor.confirm(),
    }),
  );
  ctx.effect(() =>
    project.registerProjectClose({
      id: "documents",
      check: (path) => documents.editor.confirm(path),
      closed: (path) => documents.releaseProject(path),
    }),
  );
}
