import type { SessionSnapshot } from "./projectSessions.ts";
import type { SessionTarget } from "./session.ts";
import type {
  AawNextPayload,
  AawPlanPayload,
  AawWorkflowStatus,
} from "./workflowModel.ts";

export interface WorkflowStatusValues {
  readonly workspacePath: string | null;
  readonly hasSource: boolean;
  readonly srs: readonly string[];
  readonly currentSr: string | null;
  readonly status: AawWorkflowStatus | null;
  readonly next: AawNextPayload | null;
  readonly plan: AawPlanPayload | null;
  readonly isLoading: boolean;
  readonly lastError: string | null;
  readonly lastRefreshedAt: string | null;
  readonly autoRefresh: boolean;
}

export const emptyWorkflowStatus: Readonly<WorkflowStatusValues> = {
  workspacePath: null,
  hasSource: false,
  srs: [],
  currentSr: null,
  status: null,
  next: null,
  plan: null,
  isLoading: false,
  lastError: null,
  lastRefreshedAt: null,
  autoRefresh: true,
};

export interface WorkflowWorkspace {
  readonly workspacePath: string;
  readonly uvCommand: string;
  readonly aawScriptPath: string;
}

export interface WorkflowService {
  readonly status: SessionSnapshot<WorkflowStatusValues>;
  isActive(): boolean;
  bindWorkspace(options: WorkflowWorkspace | null): () => void;
  refresh(): Promise<void>;
  selectSr(sr: string): void;
  setAutoRefresh(enabled: boolean): void;
  submit(target: SessionTarget, prompt: string, queued?: boolean): boolean;
}
