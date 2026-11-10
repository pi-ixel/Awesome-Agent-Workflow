import type { ApprovalValues } from "../interactions/types.ts";
import type { ConversationValues } from "./types.ts";
import type { RuntimeStatusValues } from "../types.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

export interface ProjectForeground {
  readonly session: ReadonlySnapshot<ConversationValues>;
  readonly approval: ReadonlySnapshot<ApprovalValues>;
  readonly runtime: ReadonlySnapshot<RuntimeStatusValues>;
}

/** Identity captured by a view before dispatching a foreground-only command. */
export interface ForegroundSessionTarget {
  readonly workspacePath: string | null;
  readonly agentKey: string | undefined;
  readonly sessionId: string | null;
}

export interface ConversationExpansion {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
  subscribe(key: string, listener: () => void): () => void;
}

export const emptySession: ConversationValues = {
  items: [],
  recovery: { state: "idle", attempt: 0, reason: "" },
  connectionFailure: null,
  queuedPrompts: [],
  queuePaused: false,
  isAgentRunning: false,
  turnState: "idle",
  isWaitingForActivity: false,
  isAwaitingUser: false,
  lastStopReason: null,
  modelLabel: null,
  availableModels: [],
  currentModelId: null,
  pendingModelId: null,
  availableModes: [],
  pendingModeId: null,
  approvalMode: null,
  isBound: false,
  sessions: [],
  sessionsByPath: {},
  activeSessionId: null,
  openingSessionId: null,
  isConnecting: false,
  operationsBlocked: false,
  isDraftPreparing: false,
  turnError: null,
  agentCrashed: null,
  lastError: null,
};

export const emptyApproval: ApprovalValues = {
  pending: [],
  activeId: null,
  questionDrafts: {},
};

export const emptyRuntime: RuntimeStatusValues = {
  runtime: {
    agentProfile: null,
    displayName: null,
    modelProfileId: null,
    modelName: null,
    modelProvider: null,
    maxContextTokens: null,
    skillNames: [],
    toolNames: [],
    skillSources: [],
    mcpServers: [],
    mcpFailures: [],
  },
  usage: null,
  usageSource: null,
  availableCommands: [],
  isTurnActive: false,
  runningToolCount: 0,
  lastSignal: null,
  lastSessionId: null,
};
