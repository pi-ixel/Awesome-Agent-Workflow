import {
  dirtyMarkdownDocuments,
  guardMarkdownNavigation,
} from "../stores/markdownDocumentStore.ts";
import { useWorkspaceStore } from "../stores/workspaceStore.ts";
import { useSessionStore } from "../stores/sessionStore.ts";
import { draftScopeKey } from "../ui/session/draftStore.ts";
import { create } from "zustand";
import type { DocumentAnnotation } from "./documentAnnotations.ts";
import { useRightPanelStore } from "../stores/rightPanelStore.ts";
import { useWorkbenchUiStore } from "../stores/workbenchUiStore.ts";
import { pathKey } from "./panelPaths.ts";
export const useAnnotationNavigation = create<{
  request: {
    annotation: DocumentAnnotation;
    nonce: number;
    scope: string;
    draft: boolean;
    ready: boolean;
  } | null;
}>(() => ({ request: null }));
let navigationId = 0;
export function openAnnotation(
  annotation: DocumentAnnotation,
  draft = false,
): void {
  if (
    dirtyMarkdownDocuments().some(
      (doc) => pathKey(doc.path) !== pathKey(annotation.path),
    ) &&
    !guardMarkdownNavigation(() => openAnnotation(annotation, draft))
  )
    return;
  if (
    pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
    pathKey(annotation.project)
  ) {
    useWorkbenchUiStore.getState().openProjectOverview(annotation.project);
  }
  useAnnotationNavigation.setState({
    request: {
      annotation,
      nonce: ++navigationId,
      ready: false,
      draft,
      scope: draftScopeKey(
        pathKey(useWorkspaceStore.getState().activePath ?? "") ===
          pathKey(annotation.project)
          ? useWorkspaceStore.getState().activePath!
          : annotation.project,
        pathKey(useWorkspaceStore.getState().activePath ?? "") ===
          pathKey(annotation.project)
          ? (useSessionStore.getState().openingSessionId ??
              useSessionStore.getState().activeSessionId)
          : null,
      ),
    },
  });
  useRightPanelStore.getState().tool(annotation.project, "files");
}
