import type { AnnotationDraftService } from "../composer/annotationTypes.ts";
import type { ProjectForeground } from "./viewState.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createStoreView } from "./storeView.ts";
import { createApprovalStore } from "../interactions/approvalStore.ts";
import { createRuntimeStatusStore } from "./runtimeStatusStore.ts";
import { createSessionStore } from "./sessionStore.ts";
import { createForegroundActivity } from "./activity.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

export function createProjectForeground(
  annotationDrafts?: AnnotationDraftService,
  loggerFactory = createLogger,
) {
  const session = createStoreView(
    createSessionStore(undefined, annotationDrafts, undefined, loggerFactory("session")),
  );
  const approval = createStoreView(createApprovalStore(loggerFactory("approval")));
  let selectedStatus = createRuntimeStatusStore(loggerFactory("usage"));
  const runtime = createStoreView(selectedStatus);
  let rateObservers = 0;
  const activity = createForegroundActivity(loggerFactory("project"));
  const view = {
    session: session.view,
    approval: approval.view,
    runtime: runtime.view,
  };
  const sessionSnapshot = createSnapshotView(view.session, (state) => ({
    agentKey: state.agentKey,
    supportsImages: state.supportsImages,
    items: state.items,
    hasCumulativePromptUsage: state.hasCumulativePromptUsage,
    recovery: state.recovery,
    connectionFailure: state.connectionFailure,
    queuedPrompts: state.queuedPrompts,
    queuePaused: state.queuePaused,
    isAgentRunning: state.isAgentRunning,
    turnState: state.turnState,
    isWaitingForActivity: state.isWaitingForActivity,
    isAwaitingUser: state.isAwaitingUser,
    lastStopReason: state.lastStopReason,
    modelLabel: state.modelLabel,
    availableModels: state.availableModels,
    currentModelId: state.currentModelId,
    pendingModelId: state.pendingModelId,
    availableModes: state.availableModes,
    pendingModeId: state.pendingModeId,
    approvalMode: state.approvalMode,
    isBound: state.isBound,
    sessions: state.sessions,
    sessionsByPath: state.sessionsByPath,
    activeSessionId: state.activeSessionId,
    openingSessionId: state.openingSessionId,
    isConnecting: state.isConnecting,
    operationsBlocked: state.operationsBlocked,
    isDraftPreparing: state.isDraftPreparing,
    turnError: state.turnError,
    agentCrashed: state.agentCrashed,
    lastError: state.lastError,
    queueSaveError: state.queueSaveError,
  }));
  const approvalSnapshot = createSnapshotView(
    view.approval,
    ({ pending, activeId, questionDrafts }) => ({ pending, activeId, questionDrafts }),
  );
  const runtimeSnapshot = createSnapshotView(view.runtime, (state) => ({
    runtime: state.runtime,
    usage: state.usage,
    usageSource: state.usageSource,
    availableCommands: state.availableCommands,
    isTurnActive: state.isTurnActive,
    runningToolCount: state.runningToolCount,
    outputTokensPerSecond: state.outputTokensPerSecond,
    lastSignal: state.lastSignal,
    lastSessionId: state.lastSessionId,
  }));
  const snapshot = {
    session: sessionSnapshot.snapshot,
    approval: approvalSnapshot.snapshot,
    runtime: runtimeSnapshot.snapshot,
    observeOutputRate() {
      rateObservers += 1;
      selectedStatus.getState().setOutputRateEnabled(true);
      return () => {
        rateObservers -= 1;
        if (rateObservers === 0)
          selectedStatus.getState().setOutputRateEnabled(false);
      };
    },
  } satisfies ProjectForeground;

  return {
    view,
    snapshot,
    activity,
    select(
      store: ReturnType<typeof createSessionStore>,
      approvals = createApprovalStore(loggerFactory("approval")),
      status = createRuntimeStatusStore(loggerFactory("usage")),
    ) {
      if (selectedStatus !== status) {
        selectedStatus.getState().setOutputRateEnabled(false);
        selectedStatus = status;
        status.getState().setOutputRateEnabled(rateObservers > 0);
      }
      session.select(store);
      approval.select(approvals);
      runtime.select(status);
    },
    dispose() {
      selectedStatus.getState().setOutputRateEnabled(false);
      activity.dispose();
      session.dispose();
      approval.dispose();
      runtime.dispose();
      sessionSnapshot.dispose();
      approvalSnapshot.dispose();
      runtimeSnapshot.dispose();
    },
  };
}

export type ProjectForegroundStores = ReturnType<typeof createProjectForeground>["view"];
