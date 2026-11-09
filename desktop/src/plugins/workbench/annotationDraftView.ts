import { useEffect } from "react";
import {
  emptyAnnotationDraft,
  type AnnotationDraftService,
} from "../../contracts/annotationDrafts.ts";
import { useRegisteredSnapshot, useWorkbenchProject } from "./react.ts";

export function useAnnotationDraftService():
  AnnotationDraftService | undefined {
  return useWorkbenchProject()?.annotationDrafts;
}

export function useAnnotationDraft(
  store: AnnotationDraftService | undefined,
  scope: string | null,
) {
  const draft = useRegisteredSnapshot(
    store,
    (state) =>
      (scope ? state?.drafts[scope] : undefined) ?? emptyAnnotationDraft,
  );
  useEffect(() => {
    if (scope) store?.getState().ensure(scope);
  }, [scope, store]);
  return draft;
}
