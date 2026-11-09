import type { createProjectForeground } from "./conversation/foreground.ts";
import type { createMessageImageHistory } from "./messageImageHistory.ts";
import type { createProjectComposer } from "./composer/service.ts";
import { createConversationExpansion } from "./conversation/expansion.ts";
import type { createAnnotationDraftStore } from "./composer/annotationDraftStore.ts";
import type { ExitReason, WorkbenchLayout } from "../../contracts/workbench.ts";
import type { HostDialogs } from "../../contracts/host.ts";
import type { FormResponse } from "../../contracts/elicitation.ts";
import type { ContentBlock } from "../../contracts/acpProtocol.ts";
import type {
  ForegroundSessionListener,
  ProjectCloseParticipant,
  ProjectPreferences,
  ProjectService,
} from "../../contracts/project.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import type {
  OpenSessionOptions,
  SessionTarget,
} from "../../contracts/session.ts";
import type { createSessionStore } from "./conversation/sessionStore.ts";
import { createSessionStatusView } from "./conversation/sessionStatusUiStore.ts";
import type { createApprovalStore } from "./interactions/approvalStore.ts";
import type { createElicitationQueue } from "./interactions/elicitationStore.ts";
import { startSessionAutoArchiveScheduler } from "./sessionArchive.ts";
import type { createWorkspaceStore } from "./workspaceStore.ts";
import type { WorkspaceHealthCheck } from "../../contracts/workspace.ts";
import { startNewSession } from "./sessionStart.ts";
import { openSessionFromEntry } from "./sessionEntry.ts";
import { SessionNavigationQueue } from "./sessionNavigationQueue.ts";
import type { createProjectSessionIndexes } from "./sessionIndexes.ts";

interface ProjectSessionView {
  readonly disposed: boolean;
  readonly recovering?: boolean;
  readonly store: ReturnType<typeof createSessionStore>;
  readonly approval: ReturnType<typeof createApprovalStore>;
}

/** 项目操作与现有会话资源之间的装配端口。 */
export type ProjectOperations = Pick<
  ProjectService,
  | "registerProject"
  | "beginDraft"
  | "focusSession"
  | "renameSession"
  | "preloadSessionList"
  | "attachPreloading"
  | "hasRunningSessions"
  | "busySessionIds"
  | "runtimeDebugSnapshot"
  | "openSession"
  | "recoverSession"
  | "stopRecovery"
  | "switchAgent"
  | "closeProject"
  | "closeSession"
> & {
  close(options?: { force?: boolean }): Promise<void>;
  dispose?(options?: { force?: boolean }): Promise<void>;
  findSession(target: SessionTarget): ProjectSessionView | undefined;
};

export class DesktopProject implements ProjectService {
  private readonly navigationQueue = new SessionNavigationQueue();
  private readonly statusViewOwner = createSessionStatusView();
  private readonly expansionOwner = createConversationExpansion();
  readonly expansion: ProjectService["expansion"] = this.expansionOwner;
  readonly statusView: ProjectService["statusView"] = this.statusViewOwner.store;
  readonly forms: ProjectService["forms"];
  readonly catalog: ProjectService["catalog"];
  readonly activity: ProjectService["activity"];
  readonly archive: ProjectService["archive"];
  readonly foreground: ProjectService["foreground"];
  readonly composer: ProjectService["composer"];
  readonly annotationDrafts: ProjectService["annotationDrafts"];
  readonly workspace: ProjectService["workspace"];
  private users = 0;
  private detach?: () => void;
  private stopping = false;
  private shutdownTask?: Promise<void>;
  private stopArchive?: () => void;
  private readonly closeParticipants = new Map<
    string,
    ProjectCloseParticipant
  >();
  private readonly closingProjects = new Map<string, Promise<void>>();

  constructor(
    private readonly operations: ProjectOperations,
    readonly preferences: ProjectPreferences,
    private readonly formQueue: ReturnType<typeof createElicitationQueue>,
    private readonly indexes: ReturnType<typeof createProjectSessionIndexes>,
    private readonly workspaceOwner: ReturnType<typeof createWorkspaceStore>,
    private readonly annotationOwner: ReturnType<typeof createAnnotationDraftStore>,
    private readonly foregroundOwner: ReturnType<typeof createProjectForeground>,
    private readonly composerOwner: ReturnType<typeof createProjectComposer>,
    private readonly messageImages: ReturnType<typeof createMessageImageHistory>,
    private readonly getLayout: () => WorkbenchLayout | undefined,
    private readonly dialogs: HostDialogs,
  ) {
    this.forms = formQueue.store;
    this.foreground = foregroundOwner.view;
    this.composer = composerOwner.service;
    this.annotationDrafts = annotationOwner.service;
    this.catalog = indexes.catalog.store;
    this.activity = indexes.activity;
    this.archive = indexes.archive;
    this.workspace = workspaceOwner.store;
  }

  startAutoArchive(): () => void {
    this.assertOpen();
    this.stopArchive?.();
    const stop = startSessionAutoArchiveScheduler(
      this.preferences,
      this,
      (agentKey) => this.operations.busySessionIds(agentKey),
    );
    const release = () => {
      if (this.stopArchive !== release) return;
      this.stopArchive = undefined;
      stop();
    };
    this.stopArchive = release;
    return release;
  }

  registerWorkspaceHealthCheck(check: WorkspaceHealthCheck): () => void {
    this.assertOpen();
    return this.workspaceOwner.registerHealthCheck(check);
  }

  private assertOpen(): void {
    if (this.stopping) throw new Error("Project service is stopping");
  }

  isActive(): boolean {
    return !this.stopping;
  }

  async pickDirectory(): Promise<string | null> {
    if (!this.isActive()) return null;
    const path = await this.dialogs.pickDirectory("选择项目目录");
    return this.isActive() ? path : null;
  }

  registerProject(path: string): void {
    this.assertOpen();
    this.operations.registerProject(path);
  }

  beginDraft(path: string) {
    this.assertOpen();
    return this.operations.beginDraft(path);
  }

  startNewSession(path: string) {
    const layout = this.getLayout();
    if (!layout)
      return Promise.resolve({ ok: false as const, reason: "工作台尚未就绪" });
    return startNewSession(this, layout, path, () => !this.stopping && this.getLayout() === layout);
  }

  openSessionFromEntry(path: string, sessionId: string, agentKey?: string) {
    const layout = this.getLayout();
    if (!layout) return Promise.resolve();
    return openSessionFromEntry(
      this,
      layout,
      path,
      sessionId,
      agentKey,
      () => !this.stopping && this.getLayout() === layout,
      () => this.navigationQueue.supersede(),
    );
  }

  enqueueSessionNavigation<T>(
    task: (isLatest: () => boolean) => Promise<T>,
    cancelled: T,
  ) {
    return this.navigationQueue.enqueue(task, cancelled);
  }
  focusSession(path: string, sessionId: string, agentKey?: string): boolean {
    this.assertOpen();
    return this.operations.focusSession(path, sessionId, agentKey);
  }
  renameSession(agentKey: string, sessionId: string, title: string): void {
    this.assertOpen();
    this.operations.renameSession(agentKey, sessionId, title);
  }
  preloadSessionList(path: string, retry = false): Promise<void> {
    this.assertOpen();
    return this.operations.preloadSessionList(path, retry);
  }
  openSession(path: string, options?: OpenSessionOptions) {
    this.assertOpen();
    return this.operations.openSession(path, options);
  }
  recoverSession(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.operations.recoverSession(target);
  }
  stopRecovery(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.operations.stopRecovery(target);
  }
  switchAgent(agentId: string): Promise<void> {
    this.assertOpen();
    return this.operations.switchAgent(agentId);
  }
  closeProject(path: string): Promise<void> {
    this.assertOpen();
    const key = pathKey(path);
    const existing = this.closingProjects.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(async () => {
        const participants = [...this.closeParticipants.values()];
        for (const participant of participants) {
          if (!(await participant.check(path))) return;
        }
        if (this.stopping) return;
        await this.operations.closeProject(path);
        await Promise.all(
          participants.map(async (participant) => {
            if (this.closeParticipants.get(participant.id) === participant)
              await participant.closed(path);
          }),
        );
      })
      .finally(() => this.closingProjects.delete(key));
    this.closingProjects.set(key, task);
    return task;
  }
  registerProjectClose(participant: ProjectCloseParticipant): () => void {
    this.assertOpen();
    if (this.closeParticipants.has(participant.id))
      throw new Error(`Duplicate project close participant: ${participant.id}`);
    this.closeParticipants.set(participant.id, participant);
    return () => {
      if (this.closeParticipants.get(participant.id) === participant)
        this.closeParticipants.delete(participant.id);
    };
  }
  subscribeSessionActivity(listener: ForegroundSessionListener): () => void {
    this.assertOpen();
    return this.foregroundOwner.activity.subscribe(listener);
  }
  hasRunningSessions(): boolean {
    return this.operations.hasRunningSessions();
  }
  prepareExit(reason: ExitReason, force: boolean): void | Promise<void> {
    const { session, approval } = this.foregroundOwner.view;
    const active = session.getState();
    if (reason === "update") {
      active.flushSessionLog();
      return this.closeProjects({ force });
    }
    if (active.isAgentRunning) active.requestCancel();
    const approvals = approval.getState();
    for (const item of approvals.pending) {
      if (item.kind === "permission") approvals.cancelPermission(item.id);
      else approvals.cancelQuestions(item.id);
    }
  }
  busySessionIds(agentKey?: string, path?: string): ReadonlySet<string> {
    return this.operations.busySessionIds(agentKey, path);
  }
  runtimeDebugSnapshot() {
    return this.operations.runtimeDebugSnapshot();
  }
  closeSession(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.operations.closeSession(target);
  }
  closeProjects(options?: { force?: boolean }): Promise<void> {
    this.assertOpen();
    return this.operations.close(options);
  }
  answerForm(id: string, action: FormResponse["action"]): void {
    this.assertOpen();
    this.formQueue.store.getState().answer(id, action);
  }
  private session(target: SessionTarget) {
    this.assertOpen();
    const session = this.operations.findSession(target);
    if (!session)
      throw new Error("Session is not open for this Agent and project");
    return session;
  }
  decidePermission(target: SessionTarget, id: string, optionId: string): void {
    const session = this.session(target);
    if (
      !session.disposed &&
      !session.recovering &&
      !session.store.getState().operationsBlocked
    )
      session.approval.getState().decidePermission(id, optionId);
  }
  cancelPermission(target: SessionTarget, id: string): void {
    const session = this.session(target);
    if (!session.disposed) session.approval.getState().cancelPermission(id);
  }
  submitAnswers(
    target: SessionTarget,
    id: string,
    selections: readonly (readonly string[])[],
    notes?: readonly (string | undefined)[],
  ): void {
    const session = this.session(target);
    if (
      !session.disposed &&
      !session.recovering &&
      !session.store.getState().operationsBlocked
    )
      session.approval.getState().submitAnswers(id, selections, notes);
  }
  cancelQuestions(target: SessionTarget, id: string): void {
    const session = this.session(target);
    if (!session.disposed) session.approval.getState().cancelQuestions(id);
  }
  send(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean {
    const session = this.session(target);
    return (
      !session.disposed &&
      session.store.getState().sendPrompt(text, attachments)
    );
  }
  enqueue(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean {
    const session = this.session(target);
    return (
      !session.disposed &&
      !session.store.getState().operationsBlocked &&
      session.store.getState().enqueuePrompt(text, attachments)
    );
  }
  clearQueue(target: SessionTarget): void {
    const session = this.session(target);
    if (!session.disposed) session.store.getState().clearQueue();
  }
  removeQueuedPrompt(target: SessionTarget, index: number): void {
    const session = this.session(target);
    if (!session.disposed) session.store.getState().removeQueuedPrompt(index);
  }
  switchModel(target: SessionTarget, modelId: string): void {
    const session = this.session(target);
    if (!session.disposed && !session.store.getState().operationsBlocked)
      session.store.getState().switchModel(modelId);
  }
  switchMode(target: SessionTarget, modeId: string): void {
    const session = this.session(target);
    if (!session.disposed && !session.store.getState().operationsBlocked)
      session.store.getState().switchMode(modeId);
  }
  cancel(target: SessionTarget): void {
    const session = this.session(target);
    session.store.getState().requestCancel();
  }
  retry(target: SessionTarget): void {
    const session = this.session(target);
    session.store.getState().retryLastPrompt();
  }
  continueQueue(target: SessionTarget): void {
    const session = this.session(target);
    session.store.getState().resumeQueue();
  }
  attachPreloading(): () => void {
    this.assertOpen();
    if (this.users === 0) this.detach = this.operations.attachPreloading();
    this.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.users !== 0) return;
      const detach = this.detach;
      this.detach = undefined;
      detach?.();
    };
  }
  shutdown(options?: { force?: boolean }): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    const detach = this.detach;
    this.detach = undefined;
    this.shutdownTask = (async () => {
      try {
        this.navigationQueue.dispose();
        this.formQueue.dispose();
        this.stopArchive?.();
        this.indexes.dispose();
        this.closeParticipants.clear();
        detach?.();
      } finally {
        this.foregroundOwner.dispose();
        const flushImageDrafts = this.composerOwner.dispose();
        this.expansionOwner.dispose();
        this.workspaceOwner.dispose();
        this.annotationOwner.dispose();
        this.statusViewOwner.dispose();
        try {
          if (this.operations.dispose) await this.operations.dispose(options);
          else await this.operations.close(options);
        } finally {
          await Promise.all([flushImageDrafts, this.messageImages.dispose()]);
        }
      }
    })();
    return this.shutdownTask;
  }
}
