import type { ForegroundSessionListener } from "./events.ts";
import type {
  WorkspaceHealthCheck,
  WorkspaceToolPaths,
  WorkspaceView,
} from "./workspace/types.ts";
import type {
  AcpProtocolSessionOptions,
  AcpSessionPort,
} from "../acpRuntime/types.ts";
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
import type { SessionGroupPublisher, SessionGroupsState } from "./sessions/sessionGroups.ts";
export type {
  SessionGroup,
  SessionGroupMember,
  SessionGroupPublisher,
  SessionGroupsState,
  SessionGroupStatus,
} from "./sessions/sessionGroups.ts";
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
  showConversation(this: void, path: string): void;
  isConversationVisible(this: void, path: string): boolean;
  openSessionFromEntry(
    path: string,
    sessionId: string,
    agentKey?: string,
  ): Promise<void>;
  /**
   * 外部会话收养端口（ADR 024 §9 开放问题 1）：插件自建并调度的 ACP 会话
   * （workflow 节点会话）登记进标准会话体系，取得侧栏条目、活动感知与
   * 中央 SessionView——与用户会话同一套折叠/渲染/审批规则。
   *
   * 职责分界：project 建视图与目录状态（事件投影、审批/表单/问答挂接、
   * catalog 登记、本地快照恢复），并提供**标准会话回调**给 create；调用方
   * 在 create 里开连接、完成握手（initialize → new/load → 私有扩展）并
   * 返回已具身份的端口。连接与释出归调用方，进程恢复也归调度方（收养
   * 会话不参与 project 侧的连接恢复）。
   *
   * 输入语义固定为「调度方驱动」：发送经 onUserMessage 路由（工作流节点
   * 会话进原生消息队列，轮次边界送达）；停止走标准 ACP cancel（协议层
   * turn 事件驱动运行态，与用户会话零分叉）。同 sessionId 重复收养幂等
   * （换接新端口、视图保留）。
   */
  adoptExternalSession(options: {
    readonly workspacePath: string;
    /** 侧栏初始标题（如工作流节点角色名）；chrys 自动改题后随原生标题。 */
    readonly title?: string;
    /** 用户补充消息路由（轮次边界送达语义由调用方承担）。 */
    readonly onUserMessage: (sessionId: string, text: string) => Promise<void>;
    /**
     * 按注入的标准会话回调装配并初始化会话：open（可带需求单的
     * mcpServers 等会话级参数）→ initialize → new/load → 返回端口。
     * 返回值必须是完整 AcpSessionPort（project 要挂事件投影
     * acp.onEvent 与下行绑定）；抛错视为 spawn 失败（project 清理现场
     * 后原样上抛）。连接释出归调用方（closeSession + 池 release）。
     */
    readonly create: (
      sessionOptions: AcpProtocolSessionOptions,
      context: { readonly agentKey: string },
    ) => Promise<AcpSessionPort>;
  }): Promise<{ readonly sessionId: string } | null>;
  deliverToSession(
    path: string,
    selection: SessionSelection,
    isActive: () => boolean,
    deliver: (owner: SessionTarget, queued: boolean) => boolean,
  ): Promise<SessionDeliveryResult>;
  renameSession(agentKey: string, sessionId: string, title: string): void | Promise<void>;
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
