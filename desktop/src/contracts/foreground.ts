import type { ApprovalValues, ApprovalViewState } from "./approval.ts";
import type {
  ConversationValues,
  ConversationViewState,
} from "./conversation.ts";
import type { RuntimeStatusValues } from "./runtimeSnapshot.ts";
import type { SessionSnapshot } from "./projectSessions.ts";

export interface ProjectForeground {
  readonly session: SessionSnapshot<ConversationViewState>;
  readonly approval: SessionSnapshot<ApprovalViewState>;
  readonly runtime: SessionSnapshot<RuntimeStatusValues>;
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
