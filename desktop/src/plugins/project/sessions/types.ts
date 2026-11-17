/** 会话操作必须携带项目与 Agent 归属，同 ID 不足以确定目标。 */
export interface SessionTarget {
  workspacePath: string;
  agentKey: string;
  sessionId: string | null;
}

export interface OpenSessionOptions {
  readonly forceNew?: boolean;
  readonly shouldFocus?: () => boolean;
  readonly sessionId?: string;
  readonly background?: boolean;
  readonly listOnly?: boolean;
  readonly draft?: boolean;
  /** Create the session while the editable draft stays in the foreground. */
  readonly createFromDraft?: boolean;
}

export type OpenSessionResult = {
  readonly sessionId: string | null;
  readonly draft: boolean;
} | null;

export interface BackgroundPrompt {
  readonly workspacePath: string;
  readonly agentId: string;
  readonly title: string;
  readonly text: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface BackgroundPromptOptions {
  readonly models: readonly { value: string; label: string }[];
  readonly efforts: readonly { value: string; label: string }[];
}
