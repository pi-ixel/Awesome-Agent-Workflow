import { useWorkbenchUiStore } from "./layout.ts";
import { bindForeground, foregroundFixture } from "./foreground.ts";
import { createMessageImageHistory } from "../../src/plugins/project/conversation/messageImageHistory.ts";
import { createAnnotationDraftStore } from "../../src/plugins/project/composer/annotationDraftStore.ts";
import { createTestWorkspace } from "./workspace.ts";
import type { AcpProtocolResources } from "../../src/plugins/acpRuntime/types.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import { createElicitationQueue } from "../../src/plugins/project/interactions/elicitationStore.ts";
import { createSessionCoordinator, type ProjectSessionDependencies } from "../../src/plugins/project/sessions/sessionCoordinator.ts";
import { createTestProjectPreferences } from "./projectPreferences.tsx";

export type { RealWorkspaceOpenResult } from "../../src/plugins/project/sessions/sessionCoordinator.ts";

let workspace: ProjectSessionDependencies["workspace"] = createTestWorkspace();
let annotationDrafts = createAnnotationDraftStore(webviewStorage).service;
export function bindProjectDependencies(dependencies: ProjectSessionDependencies): void {
  workspace = dependencies.workspace;
  annotationDrafts = dependencies.annotationDrafts;
  bindForeground(dependencies.foreground);
}

let protocol: AcpProtocolResources | undefined;
let agents: AgentsService | undefined;
export const projectIndexes = createProjectSessionIndexes(webviewStorage);
export const projectPreferences = createTestProjectPreferences();

/** Driver for tests that inspect the coordinator's internal session state. */
export function bindRuntimeServices(
  value: AcpProtocolResources,
  agentService: AgentsService,
): void {
  protocol = value;
  agents = agentService;
}

export const {
  switchRuntimeAgent,
  recoverSessionRuntime,
  stopSessionRecoveryRuntime,
  hasRunningSessions,
  busyRuntimeSessionIds,
  runtimeDebugSnapshot,
  backgroundPendingCount,
  unfocusRealRuntime,
  beginDraftWorkspace,
  focusExistingSession,
  renameCatalogSession,
  preloadSessionList,
  preloadSessionLists,
  attachSessionPreloading,
  switchRealSession,
  closeRealRuntime,
  openRealWorkspace,
  closeProjectRuntime,
  findSessionRuntime,
  closeSessionRuntime,
  adoptExternalSessionRuntime,
  projectFactory,
  dispose,
} = createSessionCoordinator({
  workspace: {
    getState: () => workspace.getState(),
    getInitialState: () => workspace.getInitialState(),
    subscribe: (listener) => workspace.subscribe(listener),
  },
  indexes: projectIndexes,
  forms: createElicitationQueue(),
  foreground: foregroundFixture,
  messageImages: createMessageImageHistory(),
  annotationDrafts: {
    getState: () => annotationDrafts.getState(),
    getInitialState: () => annotationDrafts.getInitialState(),
    subscribe: (listener) => annotationDrafts.subscribe(listener),
    isActive: () => annotationDrafts.isActive(),
    ensure: (scope) => annotationDrafts.ensure(scope),
    put: (scope, annotations) => annotationDrafts.put(scope, annotations),
    submit: (scope, prompt) => annotationDrafts.submit(scope, prompt),
    settle: (prompt, failed) => annotationDrafts.settle(prompt, failed),
    recover: (scope, id) => annotationDrafts.recover(scope, id),
    migrate: (from, to) => annotationDrafts.migrate(from, to),
    consumeMigration: (from, to) => annotationDrafts.consumeMigration(from, to),
  },
  getProtocol: () => {
    if (!protocol) throw new Error("Test ACP runtime is not bound");
    return protocol;
  },
  getAgents: () => {
    if (!agents) throw new Error("Test Agents service is not bound");
    return agents;
  },
  getApprovalMode: () => projectPreferences.getState().approvalMode,
  navigation: useWorkbenchUiStore,
});
