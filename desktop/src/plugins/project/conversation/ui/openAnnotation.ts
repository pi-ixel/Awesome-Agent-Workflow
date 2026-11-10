import { projectOverviewPageId } from "../../workspace/pageIds.ts";
import type { DocumentNavigation, DocumentsService } from "../../../documents/service.ts";
import type { DocumentAnnotation } from "../../../documents/types.ts";
import type { WorkbenchLayout } from "../../../workbench/types.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";

interface AnnotationNavigation {
  readonly layout: WorkbenchLayout;
  readonly documents: DocumentsService;
  readonly openFileTree: DocumentNavigation["openFileTree"];
  readonly currentTarget: (project: string) => object | undefined;
  readonly isCurrent: () => boolean;
}

export function openAnnotation(
  navigation: AnnotationNavigation,
  annotation: DocumentAnnotation,
  draft: boolean,
): void {
  const { layout, documents, openFileTree, currentTarget, isCurrent } = navigation;
  if (
    !isCurrent() || !layout.navigationGuard.isActive() || !documents.isActive()
  )
    return;
  const projectKey = pathKey(annotation.project);
  const switchingProject =
    pathKey(layout.navigation.getState().contextPath ?? "") !== projectKey;
  if (
    (switchingProject ||
      documents.editor
        .unsaved()
        .some((doc) => pathKey(doc.path) !== pathKey(annotation.path))) &&
    !layout.navigationGuard.guard(() =>
      openAnnotation(navigation, annotation, draft),
    )
  )
    return;
  if (switchingProject)
    layout.navigation.getState().openView(projectOverviewPageId, annotation.project, isCurrent);
  const target = currentTarget(annotation.project);
  if (!target) return;
  documents.requestAnnotation({ annotation, draft, target });
  openFileTree(annotation.project);
}
