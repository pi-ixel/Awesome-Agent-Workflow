import { createLogger } from "../../../shared/logging/logger.ts";
import type { createProjectForeground } from "../conversation/foreground.ts";
import type { createMessageImageHistory } from "../conversation/messageImageHistory.ts";
import type { createProjectComposer } from "../composer/service.ts";
import { createConversationExpansion } from "../conversation/expansion.ts";
import type { createAnnotationDraftStore } from "../composer/annotationDraftStore.ts";
import { createAnnotationEditing } from "../composer/annotationEditing.ts";
import type { ExitReason, WorkbenchLayout } from "../../workbench/types.ts";
import type { HostDialogs } from "../../host/types.ts";
import type { FormResponse } from "../../../contracts/acp/elicitation.ts";
import type { ContentBlock } from "../../../contracts/acp/protocol.ts";
import type { ForegroundSessionListener } from "../events.ts";
import type { ForegroundSessionTarget } from "../conversation/viewState.ts";
import type { QuestionDraft } from "../interactions/types.ts";
import type {
  ProjectCloseParticipant,
  ProjectPreferences,
  SessionDraft,
  SessionSelection,
} from "../types.ts";
import type {
  ProjectService,
  ProjectWorkspace,
  ProjectSessions,
} from "../service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { OpenSessionOptions, SessionTarget } from "../sessions/types.ts";
import type { createSessionStore } from "../conversation/sessionStore.ts";
import { createSessionStatusView } from "../conversation/sessionStatusUiStore.ts";
import type { createApprovalStore } from "../interactions/approvalStore.ts";
import type { createElicitationQueue } from "../interactions/elicitationStore.ts";
import { startSessionAutoArchiveScheduler } from "../sessions/sessionArchive.ts";
import type { createWorkspaceStore } from "../workspace/workspaceStore.ts";
import { createWorkspaceActivity } from "../workspace/workspaceActivity.ts";
import type { WorkspaceHealthCheck } from "../workspace/types.ts";
import { startNewSession } from "../sessions/sessionStart.ts";
import { projectConversationPageId } from "../workspace/pageIds.ts";
import { openSessionFromEntry } from "../sessions/sessionEntry.ts";
import { deliverToSession } from "../sessions/sessionDelivery.ts";
import { SessionNavigationQueue } from "../sessions/sessionNavigationQueue.ts";
import type { createProjectSessionIndexes } from "../sessions/sessionIndexes.ts";

interface ProjectSessionView {
  readonly disposed: boolean;
  readonly recovering?: boolean;
  readonly store: ReturnType<typeof createSessionStore>;
  readonly approval: ReturnType<typeof createApprovalStore>;
}

/** 项目操作与现有会话资源之间的装配端口。 */
export type ProjectOperations = Pick<ProjectWorkspace, "registerProject"> &
  Pick<
    ProjectSessions,
    | "renameSession"
    | "preloadSessionList"
    | "hasRunningSessions"
    | "busySessionIds"
    | "runtimeDebugSnapshot"
    | "openSession"
    | "adoptExternalSession"
    | "recoverSession"
    | "stopRecovery"
    | "switchAgent"
  > & {
    attachPreloading(): () => void;
    beginDraft(path: string): SessionDraft;
    focusSession(path: string, sessionId: string, agentKey?: string): boolean;
    close(options?: { force?: boolean }): Promise<void>;
    closeProject(path: string): Promise<void>;
    dispose?(options?: { force?: boolean }): Promise<void>;
    findSession(target: SessionTarget): ProjectSessionView | undefined;
  };

export class DesktopProject {
  readonly service: ProjectService;
  private readonly navigationQueue = new SessionNavigationQueue();
  private readonly statusViewOwner = createSessionStatusView();
  private readonly expansionOwner = createConversationExpansion();
  readonly expansion: ProjectService["conversation"]["expansion"] =
    this.expansionOwner;
  readonly catalog: ProjectService["sessions"]["catalog"];
  readonly archive: ReturnType<typeof createProjectSessionIndexes>["archive"];
  readonly foreground: ReturnType<typeof createProjectForeground>["view"];
  readonly composer: ProjectService["drafts"]["composer"];
  private readonly annotationEditing: ReturnType<
    typeof createAnnotationEditing
  >;
  readonly workspace: ReturnType<typeof createWorkspaceStore>["store"];
  private readonly workspaceActivity: ReturnType<
    typeof createWorkspaceActivity
  >;
  private detachPreloading?: () => void;
  private stopping = false;
  private shutdownTask?: Promise<void>;
  private stopArchive?: () => void;
  private readonly closeParticipants = new Map<
    string,
    ProjectCloseParticipant
  >();
  private readonly removingProjects = new Map<string, Promise<boolean>>();

  constructor(
    private readonly operations: ProjectOperations,
    readonly preferences: ProjectPreferences,
    private readonly formQueue: ReturnType<typeof createElicitationQueue>,
    private readonly indexes: ReturnType<typeof createProjectSessionIndexes>,
    private readonly workspaceOwner: ReturnType<typeof createWorkspaceStore>,
    private readonly annotationOwner: ReturnType<
      typeof createAnnotationDraftStore
    >,
    private readonly foregroundOwner: ReturnType<
      typeof createProjectForeground
    >,
    private readonly composerOwner: ReturnType<typeof createProjectComposer>,
    private readonly messageImages: ReturnType<
      typeof createMessageImageHistory
    >,
    private readonly getLayout: () => WorkbenchLayout | undefined,
    private readonly dialogs: HostDialogs,
    private readonly loggerFactory = createLogger,
  ) {
    this.foreground = foregroundOwner.view;
    this.composer = composerOwner.service;
    this.annotationEditing = createAnnotationEditing(
      annotationOwner.service,
      workspaceOwner.view,
      foregroundOwner.snapshot.session,
      {
        showConversation: this.showConversation.bind(this),
        startNewSession: this.startNewSession.bind(this),
      },
    );
    this.catalog = indexes.catalog.store;
    this.archive = indexes.archive;
    this.workspace = workspaceOwner.store;
    this.workspaceActivity = createWorkspaceActivity(
      workspaceOwner.view,
      foregroundOwner.snapshot.session,
    );
    const { dismissNotice, archiveWithNotice, unarchiveSession } =
      this.archive.getState();
    this.service = {
      projects: {
        workspace: workspaceOwner.view,
        subscribeWorkspaceActivity: this.workspaceActivity.subscribe,
        ...workspaceOwner.commands,
        pickDirectory: this.pickDirectory.bind(this),
        registerWorkspaceHealthCheck:
          this.registerWorkspaceHealthCheck.bind(this),
        registerProject: this.registerProject.bind(this),
        removeProject: this.removeProject.bind(this),
        registerProjectClose: this.registerProjectClose.bind(this),
      },
      sessions: {
        catalog: indexes.catalogView,
        activity: indexes.activityView,
        archive: indexes.archiveView,
        dismissArchiveNotice: dismissNotice,
        archiveWithNotice,
        unarchiveSession,
        startNewSession: this.startNewSession.bind(this),
        showConversation: this.showConversation.bind(this),
        isConversationVisible: this.isConversationVisible.bind(this),
        openSessionFromEntry: this.openSessionFromEntry.bind(this),
        deliverToSession: this.deliverToSession.bind(this),
        renameSession: this.renameSession.bind(this),
        renameDisplayedSession: this.renameDisplayedSession.bind(this),
        preloadSessionList: this.preloadSessionList.bind(this),
        openSession: this.openSession.bind(this),
        adoptExternalSession: this.adoptExternalSession.bind(this),
        recoverSession: this.recoverSession.bind(this),
        stopRecovery: this.stopRecovery.bind(this),
        switchAgent: this.switchAgent.bind(this),
        subscribeSessionActivity: this.subscribeSessionActivity.bind(this),
        hasRunningSessions: this.hasRunningSessions.bind(this),
        busySessionIds: this.busySessionIds.bind(this),
        runtimeDebugSnapshot: this.runtimeDebugSnapshot.bind(this),
      },
      conversation: {
        foreground: foregroundOwner.snapshot,
        expansion: this.expansion,
        statusView: this.statusViewOwner.view,
        setStatusMode: this.statusViewOwner.setMode,
        clear: this.clear.bind(this),
        dismissTurnError: this.dismissTurnError.bind(this),
        reportCommandFailure: this.reportCommandFailure.bind(this),
        send: this.send.bind(this),
        enqueue: this.enqueue.bind(this),
        clearQueue: this.clearQueue.bind(this),
        removeQueuedPrompt: this.removeQueuedPrompt.bind(this),
        removeQueuedPromptById: this.removeQueuedPromptById.bind(this),
        moveQueuedPrompt: this.moveQueuedPrompt.bind(this),
        switchModel: this.switchModel.bind(this),
        switchMode: this.switchMode.bind(this),
        cancel: this.cancel.bind(this),
        retry: this.retry.bind(this),
        continueQueue: this.continueQueue.bind(this),
        retryQueueSave: (target) => {
          const session = this.session(target);
          if (!session.disposed) session.store.getState().retryQueueSave();
        },
      },
      drafts: {
        annotationDrafts: annotationOwner.composer,
        annotationEditor: this.annotationEditing.editor,
        composer: this.composer,
      },
      interactions: {
        forms: formQueue.view,
        selectForm: formQueue.selectForm,
        progressForm: formQueue.progressForm,
        editForm: formQueue.editForm,
        activateForm: formQueue.activateForm,
        selectQuestion: this.selectQuestion.bind(this),
        setQuestionDraft: this.setQuestionDraft.bind(this),
        answerForm: this.answerForm.bind(this),
        decidePermission: this.decidePermission.bind(this),
        cancelPermission: this.cancelPermission.bind(this),
        submitAnswers: this.submitAnswers.bind(this),
        cancelQuestions: this.cancelQuestions.bind(this),
      },
      preferences,
      isActive: this.isActive.bind(this),
      prepareExit: this.prepareExit.bind(this),
      shutdown: this.shutdown.bind(this),
    };
  }

  startAutoArchive(): () => void {
    this.assertOpen();
    this.stopArchive?.();
    const stop = startSessionAutoArchiveScheduler(
      this.preferences,
      this,
      (agentKey) => this.operations.busySessionIds(agentKey),
      this.loggerFactory("session-archive"),
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
    return startNewSession(
      this,
      layout,
      path,
      () => !this.stopping && this.getLayout() === layout,
    );
  }

  showConversation(path: string): void {
    const layout = this.getLayout();
    if (!layout || !this.isActive()) return;
    layout.navigation
      .getState()
      .openView(
        projectConversationPageId,
        path,
        () => this.isActive() && this.getLayout() === layout,
      );
  }

  isConversationVisible(path: string): boolean {
    if (!this.isActive()) return false;
    const page = this.getLayout()?.navigation.getState();
    return (
      page?.overlay === null &&
      page.viewId === projectConversationPageId &&
      pathKey(page.contextPath ?? "") === pathKey(path)
    );
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
      this.loggerFactory("app"),
    );
  }

  deliverToSession(
    path: string,
    selection: SessionSelection,
    isActive: () => boolean,
    deliver: (owner: SessionTarget, queued: boolean) => boolean,
  ) {
    if (this.stopping)
      return Promise.resolve({ ok: false as const, reason: "项目服务已关闭" });
    const layout = this.getLayout();
    if (!layout?.navigationGuard.isActive())
      return Promise.resolve({ ok: false as const, reason: "工作台尚未就绪" });
    return deliverToSession(
      this,
      layout,
      path,
      selection,
      () => !this.stopping && this.getLayout() === layout && isActive(),
      deliver,
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
  renameSession(agentKey: string, sessionId: string, title: string): void | Promise<void> {
    this.assertOpen();
    return this.operations.renameSession(agentKey, sessionId, title);
  }
  renameDisplayedSession(
    path: string,
    agentKey: string | undefined,
    sessionId: string,
    title: string,
  ): void | Promise<void> {
    const contextPath = this.getLayout()?.navigation.getState().contextPath;
    const session = this.foreground.session.getState();
    if (
      !this.stopping &&
      contextPath &&
      pathKey(contextPath) === pathKey(path) &&
      session.agentKey === agentKey &&
      (session.openingSessionId ?? session.activeSessionId) === sessionId
    )
      return session.renameSession(sessionId, title);
  }

  private currentForeground(target: ForegroundSessionTarget) {
    const session = this.foreground.session.getState();
    if (
      !this.stopping &&
      this.workspace.getState().activePath === target.workspacePath &&
      session.agentKey === target.agentKey &&
      session.activeSessionId === target.sessionId
    )
      return session;
  }

  clear(target: ForegroundSessionTarget): void {
    this.currentForeground(target)?.clear();
  }

  dismissTurnError(target: ForegroundSessionTarget): void {
    this.currentForeground(target)?.clearTurnError();
  }

  reportCommandFailure(target: ForegroundSessionTarget, reason: string): void {
    this.currentForeground(target)?.setLastError(reason);
  }

  selectQuestion(target: ForegroundSessionTarget, id: string): void {
    if (this.currentForeground(target))
      this.foreground.approval.getState().select(id);
  }

  setQuestionDraft(
    target: ForegroundSessionTarget,
    id: string,
    draft: QuestionDraft,
  ): void {
    if (this.currentForeground(target))
      this.foreground.approval.getState().setQuestionDraft(id, draft);
  }
  preloadSessionList(path: string, retry = false): Promise<void> {
    this.assertOpen();
    return this.operations.preloadSessionList(path, retry);
  }
  openSession(path: string, options?: OpenSessionOptions) {
    this.assertOpen();
    return this.operations.openSession(path, options);
  }
  adoptExternalSession(options: Parameters<ProjectSessions["adoptExternalSession"]>[0]) {
    this.assertOpen();
    return this.operations.adoptExternalSession(options);
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
  removeProject(path: string, isCurrent = () => true): Promise<boolean> {
    this.assertOpen();
    const key = pathKey(path);
    const existing = this.removingProjects.get(key);
    if (existing) return existing;
    const isActive = () => !this.stopping && isCurrent();
    const task = Promise.resolve()
      .then(async () => {
        const participants = [...this.closeParticipants.values()];
        const isRegistered = (participant: ProjectCloseParticipant) =>
          this.closeParticipants.get(participant.id) === participant;
        for (const participant of participants) {
          if (
            !isActive() ||
            !isRegistered(participant) ||
            !(await participant.check(path))
          )
            return false;
        }
        if (
          !isActive() ||
          participants.length !== this.closeParticipants.size ||
          !participants.every(isRegistered)
        )
          return false;
        await this.operations.closeProject(path);
        const results = await Promise.allSettled(
          participants.map(async (participant) => {
            if (isRegistered(participant)) await participant.closed(path);
          }),
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "项目资源释放失败");
        if (this.stopping) return false;
        this.workspace.getState().removeFromRecent(path);
        return true;
      })
      .finally(() => this.removingProjects.delete(key));
    this.removingProjects.set(key, task);
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
      const save = active.flushSessionLog();
      return save ? save.then(() => this.closeProjects({ force })) : this.closeProjects({ force });
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
  private closeProjects(options?: { force?: boolean }): Promise<void> {
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
  removeQueuedPromptById(target: SessionTarget, id: string): boolean {
    const session = this.session(target);
    return (
      !session.disposed && session.store.getState().removeQueuedPromptById(id)
    );
  }
  moveQueuedPrompt(
    target: SessionTarget,
    id: string,
    targetId: string,
    position: "before" | "after",
  ): boolean {
    const session = this.session(target);
    return (
      !session.disposed &&
      session.store.getState().moveQueuedPrompt(id, targetId, position)
    );
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
  startPreloading(): () => void {
    this.assertOpen();
    this.detachPreloading ??= this.operations.attachPreloading();
    return () => this.stopPreloading();
  }
  private stopPreloading(): void {
    const detach = this.detachPreloading;
    this.detachPreloading = undefined;
    detach?.();
  }
  shutdown(options?: { force?: boolean }): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    this.annotationEditing.dispose();
    this.shutdownTask = (async () => {
      try {
        this.navigationQueue.dispose();
        this.formQueue.dispose();
        this.stopArchive?.();
        this.indexes.dispose();
        this.closeParticipants.clear();
        this.stopPreloading();
      } finally {
        this.workspaceActivity.dispose();
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
