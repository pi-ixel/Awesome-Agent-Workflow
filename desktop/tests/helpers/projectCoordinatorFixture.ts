import { useWorkbenchUiStore } from "./layout.ts";
import { bindForeground, foregroundFixture } from "./foreground.ts";
import { createMessageImageHistory } from "../../src/plugins/project/messageImageHistory.ts";
import { createAnnotationDraftStore } from "../../src/plugins/project/composer/annotationDraftStore.ts";
import type { WorkspaceService } from "../../src/contracts/workspace.ts";
import { createTestWorkspace } from "./workspace.ts";
import type { AcpProtocolResources } from "../../src/contracts/acpRuntime.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessionIndexes.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import type { AgentsService } from "../../src/contracts/agents.ts";
import { createElicitationQueue } from "../../src/plugins/project/interactions/elicitationStore.ts";
import { createSessionCoordinator, type ProjectSessionDependencies } from "../../src/plugins/project/sessionCoordinator.ts";
import { createTestProjectPreferences } from "./projectPreferences.tsx";

export type { RealWorkspaceOpenResult } from "../../src/plugins/project/sessionCoordinator.ts";

let workspace: WorkspaceService = createTestWorkspace();
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
