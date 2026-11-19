import type { AcpSessionEvent } from "../acpRuntime/events.ts";
import type {
  PluginSessionOptions,
  SessionTurnEvent,
} from "./sessions/types.ts";
import type { SessionToolProvider } from "./sessions/sessionTools.ts";
import type { SendOptions } from "./conversation/sessionStore.ts";
import type {
  DeleteSessionTarget,
  SessionDeletion,
} from "./sessions/sessionDeletion.ts";
export { projectOverviewPageId } from "./workspace/pageIds.ts";
export { knownWorkspacePaths } from "./workspace/knownPaths.ts";
export { prepareProjectLauncher } from "./workspace/launcherContext.ts";
import type { ForegroundSessionListener } from "./events.ts";
import type { WorkspaceToolPaths, WorkspaceView } from "./workspace/types.ts";
import type { AnnotationDraftSnapshot } from "./composer/annotationTypes.ts";
import type { BrowserElement } from "../../contracts/browser/types.ts";
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
import type {
  SessionGroupPublisher,
  SessionGroupsState,
} from "./sessions/sessionGroups.ts";
export type {
  SessionGroup,
  SessionGroupMember,
  SessionGroupPublisher,
  SessionGroupsState,
  SessionGroupStatus,
} from "./sessions/sessionGroups.ts";
export type {
  PluginSessionOptions,
  SessionTarget,
  SessionTurnEvent,
} from "./sessions/types.ts";
export type {
  ProjectActivities,
  ProjectActivity,
  ProjectExtension,
  ProjectQuickAction,
  ProjectSlashEntry,
  ProjectTreeAction,
} from "./ui/extension.ts";
export type {
  SessionToolContext,
  SessionToolProvider,
} from "./sessions/sessionTools.ts";
import type { ExitReason } from "../workbench/types.ts";
import type { ContentBlock } from "../../contracts/acp/protocol.ts";
import type { DocumentAnnotation } from "../documents/types.ts";
import type {
  BackgroundPrompt,
  BackgroundPromptOptions,
  OpenSessionOptions,
  OpenSessionResult,
  SessionTarget,
} from "./sessions/types.ts";
import type {
  AnnotationDraftTarget,
  AgentSwitchProgressListener,
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
  readonly toggleSessionStarred: (
    path: string,
    sessionId: string,
    agentKey?: string,
  ) => void;
  readonly dismissConnectError: (path: string) => void;
  readonly patchToolPaths: (paths: Partial<WorkspaceToolPaths>) => void;
  readonly reloadWorkspacePreferences: () => void;
  /** 注册不进入「最近项目」的路径前缀（工具项目用）。 */
  readonly setRecentExclusions: (prefixes: readonly string[]) => void;
  pickDirectory(): Promise<string | null>;
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
  readonly deletions?: ReadonlySnapshot<{
    entries: Readonly<Record<string, SessionDeletion>>;
  }>;
  canDeleteArchivedSession?(agentKey: string): boolean;
  resumePendingDeletions?(): void;
  deleteArchivedSession?(target: DeleteSessionTarget): Promise<void>;
  /** 侧栏会话分组（各发布方推送，侧栏渲染）。 */
  readonly groups: ReadonlySnapshot<SessionGroupsState>;
  /**
   * 注册一个会话分组发布方（扩展点）：把一组会话归到侧栏的一行分组下。
   * 发布方按项目路径整体替换自己的分组，dispose 时撤下全部分组。
   */
  registerSessionGroups(): SessionGroupPublisher;
  readonly dismissArchiveNotice: SessionArchiveState["dismissNotice"];
  readonly archiveWithNotice: SessionArchiveState["archiveWithNotice"];
  readonly unarchiveSession: SessionArchiveState["unarchiveSession"];
  startNewSession(path: string): Promise<StartSessionResult>;
  runBackgroundPrompt(
    request: BackgroundPrompt,
    observe: (
      session: SessionTarget & { sessionId: string },
      waiting: boolean,
    ) => Promise<void>,
  ): Promise<void>;
  backgroundPromptOptions(
    workspacePath: string,
    agentId: string,
  ): Promise<BackgroundPromptOptions>;
  /** Sessions managed by another plugin stay outside project and recent catalogs. */
  excludeSessionsFromCatalog(sessions: readonly SessionTarget[]): void;
  showConversation(this: void, path: string): void;
  isConversationVisible(this: void, path: string): boolean;
  openSessionFromEntry(
    path: string,
    sessionId: string,
    agentKey?: string,
  ): Promise<void>;
  /**
   * 登记会话附加工具（ADR 037）：会话新建、打开或重连时，应用问各登记方这个
   * 会话要额外装哪些 MCP 工具（如工作流的交结果工具）。返回的函数撤销登记。
   */
  registerSessionTools(provider: SessionToolProvider): () => void;
  /**
   * 插件打开（新建或恢复）一个普通会话（ADR 037）：会话由应用持有，出现在
   * 侧栏，用户可以直接对话；打开时不抢前台。返回会话地址；失败时抛出原因。
   * 发消息用 conversation.send（带 display 选项），轮次进展用 watchTurns。
   */
  openPluginSession(options: PluginSessionOptions): Promise<SessionTarget>;
  /** 订阅一个会话的轮次事件（不管这一轮是谁发起的）。返回的函数取消订阅。 */
  watchTurns(
    target: SessionTarget,
    listener: (event: SessionTurnEvent) => void,
  ): () => void;
  /** 订阅一个会话的原始事件（Agent 的消息、工具调用、计划等）。返回的函数取消订阅。 */
  watchEvents(
    target: SessionTarget,
    listener: (event: AcpSessionEvent) => void,
  ): () => void;
  deliverToSession(
    path: string,
    selection: SessionSelection,
    isActive: () => boolean,
    deliver: (owner: SessionTarget, queued: boolean) => boolean,
  ): Promise<SessionDeliveryResult>;
  renameSession(
    agentKey: string,
    sessionId: string,
    title: string,
  ): void | Promise<void>;
  renameDisplayedSession(
    path: string,
    agentKey: string | undefined,
    sessionId: string,
    title: string,
  ): void | Promise<void>;
  preloadSessionList(path: string, retry?: boolean): Promise<void>;
  openSession(
    path: string,
    options?: OpenSessionOptions,
  ): Promise<OpenSessionResult>;
  recoverSession(target: SessionTarget): Promise<void>;
  stopRecovery(target: SessionTarget): Promise<void>;
  switchAgent(
    agentId: string,
    onProgress?: AgentSwitchProgressListener,
  ): Promise<void>;
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
    options?: SendOptions,
  ): boolean;
  steer(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
    options?: SendOptions,
  ): boolean;
  stopSteering(target: SessionTarget): void;
  enqueue(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
    options?: SendOptions,
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
  putBrowserElements(
    scope: string,
    elements: readonly BrowserElement[],
  ): boolean;
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
