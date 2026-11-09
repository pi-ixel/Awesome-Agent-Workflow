import type { AcpSessionEvent } from "./acpSession.ts";
import type { WorkspaceHealthCheck, WorkspaceService } from "./workspace.ts";
import type { AnnotationDraftService } from "./annotationDrafts.ts";
import type { ConversationExpansion, ProjectForeground } from "./foreground.ts";
import type { ProjectComposer } from "./composer.ts";
import type { FormResponse, ProjectFormState } from "./elicitation.ts";
import type { ProjectSessionIndexes, SessionSnapshot } from "./projectSessions.ts";
import type { StoreApi } from "zustand";
import type { ExitReason } from "./workbench.ts";
import type { ContentBlock } from "./acpProtocol.ts";
import type {
  OpenSessionOptions,
  OpenSessionResult,
  SessionTarget,
} from "./session.ts";

export type ApprovalMode = "ask" | "auto-allow";
export type ChatWidth = "standard" | "wide" | "full";
export type StatusCardMode = "auto" | "panel" | "mini";

export interface SessionStatusViewState {
  readonly mode: StatusCardMode;
  setMode(mode: StatusCardMode): void;
}

export interface ProjectPreferenceValues {
  readonly approvalMode: ApprovalMode;
  readonly autoAnswerQuestions: boolean;
  readonly chatWidth: ChatWidth;
  readonly messageStreamShowTodos: boolean;
  readonly sessionAutoArchiveEnabled: boolean;
  readonly sessionAutoArchiveOlderThanDays: number;
}

export interface ProjectPreferences {
  getState: () => ProjectPreferenceValues;
  subscribe: (
    listener: (
      state: ProjectPreferenceValues,
      previous: ProjectPreferenceValues,
    ) => void,
  ) => () => void;
  setApprovalMode(mode: ApprovalMode): void;
  setAutoAnswerQuestions(enabled: boolean): void;
  setChatWidth(width: ChatWidth): void;
  setMessageStreamShowTodos(enabled: boolean): void;
  setSessionAutoArchive(enabled: boolean, olderThanDays?: number): void;
  reset(): void;
}

export interface SessionDraft {
  isCurrent(): boolean;
  fail(reason: string): void;
}

export type StartSessionResult = { ok: true } | { ok: false; reason: string };

export interface ProjectRuntimeDebugEntry {
  readonly sessionId: string | null;
  readonly workspacePath: string;
  readonly isActive: boolean;
  readonly listOnly: boolean;
  readonly isAgentRunning: boolean;
  readonly turnState: string;
  readonly queuedPrompts: number;
  readonly pendingApprovals: number;
  readonly agentCrashed: string | null;
  readonly busy: boolean;
  readonly busyReason: string | null;
}

export interface ProjectCloseParticipant {
  readonly id: string;
  check(path: string): boolean | Promise<boolean>;
  closed(path: string): void | Promise<void>;
}

export type ForegroundSessionListener = (
  workspacePath: string,
  event: AcpSessionEvent,
) => void;

/** 项目、会话目录、对话和交互的产品入口。 */
export interface ProjectService extends ProjectSessionIndexes {
  readonly preferences: ProjectPreferences;
  readonly forms: Pick<
    StoreApi<ProjectFormState>,
    "getState" | "getInitialState" | "subscribe"
  >;
  readonly workspace: WorkspaceService;
  readonly annotationDrafts: AnnotationDraftService;
  readonly foreground: ProjectForeground;
  readonly expansion: ConversationExpansion;
  readonly composer: ProjectComposer;
  readonly statusView: SessionSnapshot<SessionStatusViewState>;
  isActive(): boolean;
  pickDirectory(): Promise<string | null>;
  registerWorkspaceHealthCheck(check: WorkspaceHealthCheck): () => void;
  registerProject(path: string): void;
  beginDraft(path: string): SessionDraft;
  startNewSession(path: string): Promise<StartSessionResult>;
  openSessionFromEntry(
    path: string,
    sessionId: string,
    agentKey?: string,
  ): Promise<void>;
  enqueueSessionNavigation<T>(
    task: (isLatest: () => boolean) => Promise<T>,
    cancelled: T,
  ): Promise<T>;
  focusSession(path: string, sessionId: string, agentKey?: string): boolean;
  renameSession(agentKey: string, sessionId: string, title: string): void;
  preloadSessionList(path: string, retry?: boolean): Promise<void>;
  attachPreloading(): () => void;
  openSession(
    path: string,
    options?: OpenSessionOptions,
  ): Promise<OpenSessionResult>;
  recoverSession(target: SessionTarget): Promise<void>;
  stopRecovery(target: SessionTarget): Promise<void>;
  switchAgent(agentId: string): Promise<void>;
  closeProject(path: string): Promise<void>;
  registerProjectClose(participant: ProjectCloseParticipant): () => void;
  subscribeSessionActivity(listener: ForegroundSessionListener): () => void;
  hasRunningSessions(): boolean;
  prepareExit(reason: ExitReason, force: boolean): void | Promise<void>;
  busySessionIds(agentKey?: string, path?: string): ReadonlySet<string>;
  runtimeDebugSnapshot(): readonly ProjectRuntimeDebugEntry[];
  closeSession(target: SessionTarget): Promise<void>;
  closeProjects(options?: { force?: boolean }): Promise<void>;
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
  switchModel(target: SessionTarget, modelId: string): void;
  switchMode(target: SessionTarget, modeId: string): void;
  cancel(target: SessionTarget): void;
  retry(target: SessionTarget): void;
  continueQueue(target: SessionTarget): void;
  shutdown(options?: { force?: boolean }): Promise<void>;
}
