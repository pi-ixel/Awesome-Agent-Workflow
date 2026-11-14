export type ApprovalMode = "ask" | "auto-allow";
export type ChatWidth = "standard" | "wide" | "full";
export type MessageStreamMode = "process" | "conclusion";
export type StatusCardMode = "auto" | "panel" | "mini";

export interface SessionStatusViewState {
  readonly mode: StatusCardMode;
}

export interface ProjectPreferenceValues {
  readonly approvalMode: ApprovalMode;
  readonly autoAnswerQuestions: boolean;
  readonly chatWidth: ChatWidth;
  readonly messageStreamShowTodos: boolean;
  readonly messageStreamMode: MessageStreamMode;
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
  setMessageStreamMode(mode: MessageStreamMode): void;
  setSessionAutoArchive(enabled: boolean, olderThanDays?: number): void;
  reset(): void;
}

export interface SessionDraft {
  isCurrent(): boolean;
  fail(reason: string): void;
}

export type StartSessionResult = { ok: true } | { ok: false; reason: string };

declare const annotationTargetBrand: unique symbol;

/** Identity of an editable annotation draft within its Project instance. */
export interface AnnotationDraftTarget {
  readonly [annotationTargetBrand]: true;
}

export type SessionSelection =
  | { readonly kind: "draft" }
  | { readonly kind: "history"; readonly sessionId: string };

export type SessionDeliveryResult = { ok: true } | { ok: false; reason: string };

export interface ProjectRuntimeDebugEntry {
  readonly agentKey?: string;
  readonly queueSaveError?: string | null;
  readonly cacheSaveError?: string | null;
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

export type { FormViewItem, FormViewState } from "./interactions/form.ts";
export type { RuntimeStatusValues } from "./conversation/runtimeStatusTypes.ts";
export type {
  AssistantMessageItem,
  PlanItem,
  SessionItem,
  SystemNoticeItem,
  ToolCallItem,
  UserMessageItem,
} from "./conversation/types.ts";
export type { PendingPermission, PendingQuestions } from "./interactions/types.ts";
export type {
  SessionActivity,
  SessionCatalogState,
} from "./sessions/indexTypes.ts";
export type { SessionTarget } from "./sessions/types.ts";
export type {
  HealthCheckItem,
  WorkspaceHealthCheck,
  WorkspaceHealthCheckOptions,
  WorkspaceSnapshot,
  WorkspaceToolPaths,
  WorkspaceView,
} from "./workspace/types.ts";
