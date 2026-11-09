import type { AnnotationDraftService } from "../../../contracts/annotationDrafts.ts";
import type { ProjectForeground } from "../../../contracts/foreground.ts";
import { createStoreView } from "../../../shared/storeView.ts";
import { createApprovalStore } from "../interactions/approvalStore.ts";
import { createRuntimeStatusStore } from "./runtimeStatusStore.ts";
import { createSessionStore } from "./sessionStore.ts";
import { createForegroundActivity } from "./activity.ts";

export function createProjectForeground(
  annotationDrafts?: AnnotationDraftService,
) {
  const session = createStoreView(
    createSessionStore(undefined, annotationDrafts),
  );
  const approval = createStoreView(createApprovalStore());
  const runtime = createStoreView(createRuntimeStatusStore());
  const activity = createForegroundActivity();
  const view = {
    session: session.view,
    approval: approval.view,
    runtime: runtime.view,
  } satisfies ProjectForeground;

  return {
    view,
    activity,
    select(
      store: ReturnType<typeof createSessionStore>,
      approvals = createApprovalStore(),
      status = createRuntimeStatusStore(),
    ) {
      session.select(store);
      approval.select(approvals);
      runtime.select(status);
    },
    dispose() {
      activity.dispose();
      session.dispose();
      approval.dispose();
      runtime.dispose();
    },
  };
}

export type ProjectForegroundStores = ReturnType<typeof createProjectForeground>["view"];
