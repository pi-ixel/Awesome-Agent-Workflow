import { useEffect } from "react";
import { emptyAnnotationDraft } from "../../composer/annotationTypes.ts";
import type { ProjectAnnotationDrafts } from "../../service.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useProject } from "./projectView.tsx";

export function useAnnotationDraftService():
  ProjectAnnotationDrafts | undefined {
  return useProject()?.drafts.annotationDrafts;
}

export function useAnnotationDraft(
  store: ProjectAnnotationDrafts | undefined,
  scope: string | null,
) {
  const draft = useRegisteredSnapshot(
    store,
    (state) =>
      (scope ? state?.drafts[scope] : undefined) ?? emptyAnnotationDraft,
  );
  useEffect(() => {
    if (scope) store?.ensure(scope);
  }, [scope, store]);
  return draft;
}
