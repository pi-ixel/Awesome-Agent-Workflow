import type { DocumentsService } from "../../../../contracts/documents.ts";
import type { ProjectService } from "../../../../contracts/project.ts";
import type { DocumentAnnotation } from "../../../../contracts/documentAnnotations.ts";
import type { WorkbenchLayout } from "../../../../contracts/workbench.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";
import { draftScopeKey } from "../../composer/draftStore.ts";

export function openAnnotation(
  layout: WorkbenchLayout | undefined,
  documents: DocumentsService | undefined,
  annotation: DocumentAnnotation,
  draft = false,
  project?: Pick<ProjectService, "workspace" | "foreground">,
): void {
  if (!layout?.navigationGuard.isActive() || !documents?.isActive()) return;
  const projectKey = pathKey(annotation.project);
  const switchingProject =
    pathKey(layout.navigation.getState().contextPath ?? "") !== projectKey;
  if (
    (switchingProject ||
      documents.editor
        .unsaved()
        .some((doc) => pathKey(doc.path) !== pathKey(annotation.path))) &&
    !layout.navigationGuard.guard(() =>
      openAnnotation(layout, documents, annotation, draft, project),
    )
  )
    return;
  if (switchingProject)
    layout.navigation.getState().openProjectOverview(annotation.project);
  const activePath = project?.workspace.getState().activePath;
  const session = project?.foreground.session.getState();
  const sameProject =
    activePath != null && pathKey(activePath) === pathKey(annotation.project);
  documents.requestAnnotation({
    annotation,
    draft,
    scope: draftScopeKey(
      sameProject ? activePath : annotation.project,
      sameProject
        ? (session?.openingSessionId ?? session?.activeSessionId ?? null)
        : null,
      session?.agentKey,
    ),
  });
  layout.panels.getState().tool(annotation.project, "files");
}
