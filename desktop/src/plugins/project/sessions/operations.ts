import {
  createSessionCoordinator,
  type ProjectSessionDependencies,
} from "./sessionCoordinator.ts";
import type { ProjectOperations } from "../lifecycle/project.ts";

/** 项目服务的产品操作由同一个会话协调器负责。 */
export function createProjectOperations(
  dependencies: ProjectSessionDependencies,
): ProjectOperations {
  return projectOperationsFrom(
    createSessionCoordinator(dependencies),
    dependencies.workspace,
  );
}

export function projectOperationsFrom(
  coordinator: ReturnType<typeof createSessionCoordinator>,
  workspace: ProjectSessionDependencies["workspace"],
): ProjectOperations {
  return {
    registerProject: (path) => workspace.getState().selectWorkspace(path),
    beginDraft: coordinator.beginDraftWorkspace,
    focusSession: coordinator.focusExistingSession,
    preloadSessionList: coordinator.preloadSessionList,
    renameSession: coordinator.renameCatalogSession,
    recoverSession: coordinator.recoverSessionRuntime,
    stopRecovery: coordinator.stopSessionRecoveryRuntime,
    switchAgent: coordinator.switchRuntimeAgent,
    attachPreloading: coordinator.attachSessionPreloading,
    hasRunningSessions: coordinator.hasRunningSessions,
    busySessionIds: coordinator.busyRuntimeSessionIds,
    runtimeDebugSnapshot: coordinator.runtimeDebugSnapshot,
    close: coordinator.closeRealRuntime,
    dispose: coordinator.dispose,
    openSession: coordinator.openRealWorkspace,
    adoptExternalSession: coordinator.adoptExternalSessionRuntime,
    closeProject: coordinator.closeProjectRuntime,
    findSession: ({ workspacePath, agentKey, sessionId }) =>
      coordinator.findSessionRuntime(workspacePath, agentKey, sessionId),
  };
}
