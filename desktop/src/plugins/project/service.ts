import type { ForegroundSessionListener } from "./events.ts";
import type {
  WorkspaceHealthCheck,
  WorkspaceToolPaths,
  WorkspaceView,
} from "./workspace/types.ts";
import type { AnnotationDraftSnapshot } from "./composer/annotationTypes.ts";
import type {
  ConversationExpansion,
  ForegroundSessionTarget,
  ProjectForeground,
} from "./conversation/viewState.ts";
import type { ProjectComposer } from "./composer/types.ts";
import type {
  FormResponse,
  FormValues,
} from "../../contracts/acp/elicitation.ts";
import type { FormViewState } from "./interactions/form.ts";
import type { QuestionDraft } from "./interactions/types.ts";
import type {
  ProjectSessionIndexes,
  SessionArchiveSnapshot,
  SessionArchiveState,
} from "./sessions/indexTypes.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { ExitReason } from "../workbench/types.ts";
import type { ContentBlock } from "../../contracts/acp/protocol.ts";
import type { DocumentAnnotation } from "../documents/types.ts";
import type {
  OpenSessionOptions,
  OpenSessionResult,
  SessionTarget,
} from "./sessions/types.ts";
import type {
  AnnotationDraftTarget,
  ProjectCloseParticipant,
  ProjectPreferences,
  ProjectRuntimeDebugEntry,
  SessionDeliveryResult,
  SessionSelection,
  SessionStatusViewState,
  StartSessionResult,
  StatusCardMode,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    project: ProjectService;
  }
}

export interface ProjectWorkspace {
  readonly workspace: WorkspaceView;
  readonly subscribeWorkspaceActivity: (
    path: string,
    listener: () => void,
  ) => () => void;
  readonly selectWorkspace: (path: string) => void;
  readonly openWorkspace: (path?: string) => void;
  readonly closeWorkspace: () => void;
  readonly togglePinned: (path: string) => void;
  readonly toggleSessionPinned: (
    path: string,
    sessionId: string,
    agentKey?: string,
  ) => void;
  readonly dismissConnectError: (path: string) => void;
  readonly patchToolPaths: (paths: Partial<WorkspaceToolPaths>) => void;
  readonly runHealthChecks: (
    paths?: Partial<WorkspaceToolPaths>,
  ) => Promise<void>;
  readonly reloadWorkspacePreferences: () => void;
  pickDirectory(): Promise<string | null>;
  registerWorkspaceHealthCheck(check: WorkspaceHealthCheck): () => void;
  registerProject(path: string): void;
  /** Check and release the addressed project's resources before removing its list entry. */
  removeProject(path: string, isCurrent?: () => boolean): Promise<boolean>;
  registerProjectClose(participant: ProjectCloseParticipant): () => void;
}

export interface ProjectSessions extends Pick<
  ProjectSessionIndexes,
  "catalog" | "activity"
> {
  readonly archive: ReadonlySnapshot<SessionArchiveSnapshot>;
  readonly dismissArchiveNotice: SessionArchiveState["dismissNotice"];
  readonly archiveWithNotice: SessionArchiveState["archiveWithNotice"];
  readonly unarchiveSession: SessionArchiveState["unarchiveSession"];
  startNewSession(path: string): Promise<StartSessionResult>;
  showConversation(this: void, path: string): void;
  isConversationVisible(this: void, path: string): boolean;
  openSessionFromEntry(
    path: string,
    sessionId: string,
    agentKey?: string,
  ): Promise<void>;
  deliverToSession(
    path: string,
    selection: SessionSelection,
    isActive: () => boolean,
    deliver: (owner: SessionTarget, queued: boolean) => boolean,
  ): Promise<SessionDeliveryResult>;
  renameSession(agentKey: string, sessionId: string, title: string): void;
  renameDisplayedSession(
    path: string,
    agentKey: string | undefined,
    sessionId: string,
    title: string,
  ): void;
  preloadSessionList(path: string, retry?: boolean): Promise<void>;
  openSession(
    path: string,
    options?: OpenSessionOptions,
  ): Promise<OpenSessionResult>;
  recoverSession(target: SessionTarget): Promise<void>;
  stopRecovery(target: SessionTarget): Promise<void>;
  switchAgent(agentId: string): Promise<void>;
  subscribeSessionActivity(listener: ForegroundSessionListener): () => void;
  hasRunningSessions(): boolean;
  busySessionIds(agentKey?: string, path?: string): ReadonlySet<string>;
  runtimeDebugSnapshot(): readonly ProjectRuntimeDebugEntry[];
}

export interface ProjectConversation {
  readonly foreground: ProjectForeground;
  readonly expansion: ConversationExpansion;
  readonly statusView: ReadonlySnapshot<SessionStatusViewState>;
  readonly setStatusMode: (mode: StatusCardMode) => void;
  clear(target: ForegroundSessionTarget): void;
  dismissTurnError(target: ForegroundSessionTarget): void;
  reportCommandFailure(target: ForegroundSessionTarget, reason: string): void;
  send(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean;
  enqueue(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean;
  clearQueue(target: SessionTarget): void;
  removeQueuedPrompt(target: SessionTarget, index: number): void;
  removeQueuedPromptById(target: SessionTarget, id: string): boolean;
  moveQueuedPrompt(
    target: SessionTarget,
    id: string,
    targetId: string,
    position: "before" | "after",
  ): boolean;
  switchModel(target: SessionTarget, modelId: string): void;
  switchMode(target: SessionTarget, modeId: string): void;
  cancel(target: SessionTarget): void;
  retry(target: SessionTarget): void;
  continueQueue(target: SessionTarget): void;
  retryQueueSave?(target: SessionTarget): void;
}

export interface ProjectAnnotationEditor {
  readonly current: (project: string) => AnnotationDraftTarget | undefined;
  readonly subscribeTarget: (listener: () => void) => () => void;
  readonly read: (
    target: AnnotationDraftTarget,
  ) => readonly DocumentAnnotation[];
  readonly subscribeDrafts: (listener: () => void) => () => void;
  readonly ensure: (target: AnnotationDraftTarget) => void;
  readonly upsert: (
    target: AnnotationDraftTarget,
    annotation: DocumentAnnotation,
  ) => string | null;
  readonly remove: (target: AnnotationDraftTarget, id: string) => boolean;
  readonly followPromotion: (
    target: AnnotationDraftTarget,
    listener: (replacement: AnnotationDraftTarget) => void,
  ) => () => void;
  readonly showAfterSave: (
    project: string,
    target: AnnotationDraftTarget,
  ) => Promise<StartSessionResult | undefined>;
}

export interface ProjectAnnotationDrafts extends ReadonlySnapshot<
  Pick<AnnotationDraftSnapshot, "drafts" | "error">
> {
  ensure(scope: string): void;
  put(scope: string, annotations: readonly DocumentAnnotation[]): boolean;
  submit(scope: string, prompt: string): boolean;
  rejectSubmission(scope: string | null, prompt: string): void;
  recover(scope: string, id: string): string | null;
  consumeMigration(from: string, to: string): boolean;
  prepareLegacyDraft(scope: string, legacyScope: string): void;
  finishLegacyDraft(scope: string, from: string): void;
}

export interface ProjectDrafts {
  readonly annotationDrafts: ProjectAnnotationDrafts;
  readonly annotationEditor: ProjectAnnotationEditor;
  readonly composer: ProjectComposer;
}

export interface ProjectInteractions {
  readonly forms: ReadonlySnapshot<FormViewState>;
  readonly selectForm: (id: string) => void;
  readonly progressForm: (
    id: string,
    patch: { page?: number; interacted?: boolean },
  ) => void;
  readonly editForm: (id: string, values: FormValues) => void;
  readonly activateForm: (id: string) => void;
  selectQuestion(target: ForegroundSessionTarget, id: string): void;
  setQuestionDraft(
    target: ForegroundSessionTarget,
    id: string,
    draft: QuestionDraft,
  ): void;
  answerForm(id: string, action: FormResponse["action"]): void;
  decidePermission(target: SessionTarget, id: string, optionId: string): void;
  cancelPermission(target: SessionTarget, id: string): void;
  submitAnswers(
    target: SessionTarget,
    id: string,
    selections: readonly (readonly string[])[],
    notes?: readonly (string | undefined)[],
  ): void;
  cancelQuestions(target: SessionTarget, id: string): void;
}

/** 项目产品能力。所有分组由同一个 Cordis Fiber 持有。 */
export interface ProjectService {
  readonly projects: ProjectWorkspace;
  readonly sessions: ProjectSessions;
  readonly conversation: ProjectConversation;
  readonly drafts: ProjectDrafts;
  readonly interactions: ProjectInteractions;
  readonly preferences: ProjectPreferences;
  isActive(): boolean;
  prepareExit(reason: ExitReason, force: boolean): void | Promise<void>;
  shutdown(options?: { force?: boolean }): Promise<void>;
}
