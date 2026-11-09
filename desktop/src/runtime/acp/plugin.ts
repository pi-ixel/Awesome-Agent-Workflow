import type { FormResponse } from "../../core/elicitation.ts";
import type { ContentBlock } from "../acpBase/protocol/types.ts";
import { Service, type Context } from "cordis";
import type {
  AcpRuntimeHost,
  AcpService,
  SessionTarget,
  OpenSessionOptions,
} from "./service.ts";

export class AcpPlugin extends Service implements AcpService {
  static inject = ["acpBase"];
  private users = 0;
  private detach?: () => void;
  private stopping?: Promise<void>;
  constructor(
    ctx: Context,
    private readonly host: AcpRuntimeHost,
  ) {
    super(ctx, "acp");
    ctx.effect(() => () => this.shutdown());
  }
  private assertOpen(): void {
    if (this.stopping) throw new Error("ACP runtime is stopping");
  }
  answerForm(id: string, action: FormResponse["action"]): void {
    this.assertOpen();
    this.host.answerForm(id, action);
  }
  decidePermission(target: SessionTarget, id: string, optionId: string): void {
    this.session(target).decidePermission(id, optionId);
  }
  cancelPermission(target: SessionTarget, id: string): void {
    this.session(target).cancelPermission(id);
  }
  submitAnswers(
    target: SessionTarget,
    id: string,
    selections: readonly (readonly string[])[],
    notes?: readonly (string | undefined)[],
  ): void {
    this.session(target).submitAnswers(id, selections, notes);
  }
  cancelQuestions(target: SessionTarget, id: string): void {
    this.session(target).cancelQuestions(id);
  }
  preloadSessionList(path: string, retry = false): Promise<void> {
    this.assertOpen();
    return this.host.preloadSessionList(path, retry);
  }
  renameSession(agentKey: string, sessionId: string, title: string): void {
    this.assertOpen();
    this.host.renameSession(agentKey, sessionId, title);
  }
  beginDraft(path: string) {
    this.assertOpen();
    return this.host.beginDraft(path);
  }
  focusSession(path: string, sessionId: string, agentKey?: string): boolean {
    this.assertOpen();
    return this.host.focusSession(path, sessionId, agentKey);
  }
  switchAgent(agentId: string): Promise<void> {
    this.assertOpen();
    return this.host.switchAgent(agentId);
  }
  recoverSession(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.host.recoverSession(target);
  }
  stopRecovery(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.host.stopRecovery(target);
  }
  openSession(path: string, options?: OpenSessionOptions) {
    this.assertOpen();
    return this.host.openSession(path, options);
  }
  closeProjects(options?: { force?: boolean }): Promise<void> {
    this.assertOpen();
    return this.host.close(options);
  }
  closeProject(path: string): Promise<void> {
    this.assertOpen();
    return this.host.closeProject(path);
  }
  closeSession(target: SessionTarget): Promise<void> {
    this.assertOpen();
    return this.host.closeSession(target);
  }
  private session(target: SessionTarget) {
    this.assertOpen();
    const session = this.host.findSession(target);
    if (!session)
      throw new Error("Session is not open for this Agent and project");
    return session;
  }
  send(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean {
    return this.session(target).send(text, attachments);
  }
  enqueue(
    target: SessionTarget,
    text: string,
    attachments?: readonly ContentBlock[],
  ): boolean {
    return this.session(target).enqueue(text, attachments);
  }
  clearQueue(target: SessionTarget): void {
    this.session(target).clearQueue();
  }
  removeQueuedPrompt(target: SessionTarget, index: number): void {
    this.session(target).removeQueuedPrompt(index);
  }
  switchModel(target: SessionTarget, modelId: string): void {
    this.session(target).switchModel(modelId);
  }
  switchMode(target: SessionTarget, modeId: string): void {
    this.session(target).switchMode(modeId);
  }
  cancel(target: SessionTarget): void {
    this.session(target).cancel();
  }
  retry(target: SessionTarget): void {
    this.session(target).retry();
  }
  continueQueue(target: SessionTarget): void {
    this.session(target).continueQueue();
  }
  attachPreloading(): () => void {
    if (this.stopping) throw new Error("ACP runtime is stopping");
    if (this.users === 0) this.detach = this.host.attachPreloading();
    this.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.users === 0) {
        this.detach?.();
        this.detach = undefined;
      }
    };
  }
  shutdown(options: { force?: boolean } = {}): Promise<void> {
    return (this.stopping ??= (async () => {
      const errors: unknown[] = [];
      try {
        this.detach?.();
      } catch (error) {
        errors.push(error);
      }
      this.detach = undefined;
      try {
        await this.host.close(options);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "ACP runtime cleanup failed");
    })());
  }
}
