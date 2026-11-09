import { useElicitationStore } from "../stores/elicitationStore.ts";
import type { FormResponse } from "../core/elicitation.ts";
import { createDesktopRuntime } from "./bootstrap.ts";
import type {
  AcpService,
  OpenSessionOptions,
  SessionTarget,
} from "./acp/service.ts";
import {
  beginDraftWorkspace,
  focusExistingSession,
  preloadSessionList,
  renameCatalogSession,
  attachSessionPreloading,
  closeRealRuntime,
  openRealWorkspace,
  closeProjectRuntime,
  closeSessionRuntime,
  findSessionRuntime,
  switchRuntimeAgent,
  recoverSessionRuntime,
  stopSessionRecoveryRuntime,
} from "./acp/runtimeHost.ts";

let service: AcpService | undefined;
let runtime: ReturnType<typeof createDesktopRuntime> | undefined;
/** Main-window entry only. Diagnostic windows must not import this module. */
export function startDesktopRuntime() {
  if (runtime) return runtime;
  runtime = createDesktopRuntime({
    answerForm: (id, action) =>
      useElicitationStore.getState().answer(id, action),
    beginDraft: (path) => beginDraftWorkspace(path),
    focusSession: (path, id, owner) => focusExistingSession(path, id, owner),
    preloadSessionList: (path, retry) => preloadSessionList(path, retry),
    renameSession: (owner, id, title) => renameCatalogSession(owner, id, title),
    recoverSession: (target) => recoverSessionRuntime(target),
    stopRecovery: (target) => stopSessionRecoveryRuntime(target),
    switchAgent: (agentId) => switchRuntimeAgent(agentId),
    attachPreloading: () => attachSessionPreloading(),
    close: (options) => closeRealRuntime(options),
    openSession: (path, options) => openRealWorkspace(path, options),
    closeProject: (path) => closeProjectRuntime(path),
    closeSession: (target) =>
      closeSessionRuntime(
        target.workspacePath,
        target.agentKey,
        target.sessionId,
      ),
    findSession: (target) =>
      findSessionRuntime(
        target.workspacePath,
        target.agentKey,
        target.sessionId,
      ),
  });
  void runtime.ready
    .then(({ acp }) => {
      service = acp;
    })
    .catch(() => {});
  return runtime;
}
export async function recoverDesktopSession(
  target: SessionTarget,
): Promise<void> {
  const { acp } = await startDesktopRuntime().ready;
  await acp.recoverSession(target);
}
export async function stopDesktopRecovery(
  target: SessionTarget,
): Promise<void> {
  const { acp } = await startDesktopRuntime().ready;
  await acp.stopRecovery(target);
}
export async function switchDesktopAgent(agentId: string): Promise<void> {
  const { acp } = await startDesktopRuntime().ready;
  await acp.switchAgent(agentId);
}
export function attachDesktopPreloading(): () => void {
  let cancelled = false;
  let detach: (() => void) | undefined;
  void startDesktopRuntime()
    .ready.then(({ acp }) => {
      if (!cancelled) detach = acp.attachPreloading();
    })
    .catch((error: unknown) =>
      console.error("ACP runtime startup failed", error),
    );
  return () => {
    cancelled = true;
    detach?.();
  };
}
export function shutdownDesktopRuntime(
  options: { force?: boolean } = {},
): Promise<void> {
  return startDesktopRuntime().shutdown(options);
}

export async function openDesktopWorkspace(
  path: string,
  options?: OpenSessionOptions,
) {
  const { acp } = await startDesktopRuntime().ready;
  return acp.openSession(path, options);
}

export function getDesktopAcpService(): AcpService {
  if (!service) throw new Error("ACP Service 尚未就绪");
  return service;
}
export function beginDesktopDraft(path: string) {
  return getDesktopAcpService().beginDraft(path);
}
export function focusDesktopSession(
  path: string,
  sessionId: string,
  agentKey?: string,
): boolean {
  return getDesktopAcpService().focusSession(path, sessionId, agentKey);
}
export function renameDesktopSession(
  agentKey: string,
  sessionId: string,
  title: string,
): void {
  getDesktopAcpService().renameSession(agentKey, sessionId, title);
}
export async function preloadDesktopSessionList(
  path: string,
  retry = false,
): Promise<void> {
  const { acp } = await startDesktopRuntime().ready;
  await acp.preloadSessionList(path, retry);
}

export async function closeDesktopProjects(options?: {
  force?: boolean;
}): Promise<void> {
  const { acp } = await startDesktopRuntime().ready;
  await acp.closeProjects(options);
}

export function answerDesktopForm(
  id: string,
  action: FormResponse["action"],
): void {
  getDesktopAcpService().answerForm(id, action);
}
