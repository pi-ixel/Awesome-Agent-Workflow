import type { FormResponse } from "../../core/elicitation.ts";
import type { ContentBlock } from "../acpBase/protocol/types.ts";
import type { SessionRuntime } from "./SessionRuntime.ts";
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
}
export type OpenSessionResult = {
  readonly sessionId: string | null;
  readonly draft: boolean;
} | null;
export interface SessionDraft {
  isCurrent(): boolean;
  fail(reason: string): void;
}
/** Internal composition contract. The main window must provide every operation. */
export interface AcpRuntimeHost {
  answerForm(id: string, action: FormResponse["action"]): void;
  preloadSessionList(path: string, retry?: boolean): Promise<void>;
  renameSession(agentKey: string, sessionId: string, title: string): void;
  beginDraft(path: string): SessionDraft;
  focusSession(path: string, sessionId: string, agentKey?: string): boolean;
  recoverSession(target: SessionTarget): Promise<void>;
  stopRecovery(target: SessionTarget): Promise<void>;
  switchAgent(agentId: string): Promise<void>;
  openSession(
    path: string,
    options?: OpenSessionOptions,
  ): Promise<OpenSessionResult>;
  closeProject(path: string): Promise<void>;
  closeSession(target: SessionTarget): Promise<void>;
  findSession(target: SessionTarget): SessionRuntime | undefined;
  attachPreloading(): () => void;
  close(options?: { force?: boolean }): Promise<void>;
}
export interface AcpService {
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
  preloadSessionList(path: string, retry?: boolean): Promise<void>;
  renameSession(agentKey: string, sessionId: string, title: string): void;
  beginDraft(path: string): SessionDraft;
  focusSession(path: string, sessionId: string, agentKey?: string): boolean;
  recoverSession(target: SessionTarget): Promise<void>;
  stopRecovery(target: SessionTarget): Promise<void>;
  switchAgent(agentId: string): Promise<void>;
  openSession(
    path: string,
    options?: OpenSessionOptions,
  ): Promise<OpenSessionResult>;
  closeProjects(options?: { force?: boolean }): Promise<void>;
  closeProject(path: string): Promise<void>;
  closeSession(target: SessionTarget): Promise<void>;
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
  attachPreloading(): () => void;
  shutdown(options?: { force?: boolean }): Promise<void>;
}
