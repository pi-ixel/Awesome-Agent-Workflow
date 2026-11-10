import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useProjectView } from "../../ui/bindings/projectView.tsx";
import { useMemo } from "react";
import type { ProjectService } from "../../service.ts";
import type { ForegroundSessionTarget } from "../viewState.ts";
import type { QuestionDraft } from "../../interactions/types.ts";
import type { ContentBlock } from "../../../../contracts/acp/protocol.ts";

/** Capture the rendered owner: a late callback must never act on another session. */
export function useSessionCommands() {
  const view = useProjectView();
  const workspacePath = useWorkspaceValue((state) => state.activePath);
  const agentKey = useSessionValue((state) => state.agentKey);
  const sessionId = useSessionValue((state) => state.activeSessionId);
  return useMemo(() => {
    const foreground: ForegroundSessionTarget = { workspacePath, agentKey, sessionId };
    const target =
      workspacePath && agentKey ? { workspacePath, agentKey, sessionId } : null;
    const run = <T>(
      action: (service: ProjectService, owner: NonNullable<typeof target>) => T,
      fallback: T,
    ): T => {
      if (!target || !view?.isActive()) return fallback;
      const { project } = view;
      try {
        return action(project, target);
      } catch (error) {
        if (view.isActive())
          project.conversation.reportCommandFailure(
            target,
            error instanceof Error ? error.message : String(error),
          );
        return fallback;
      }
    };
    const runForeground = (action: (service: ProjectService) => void) => {
      if (view?.isActive()) action(view.project);
    };
    return {
      clear: () => runForeground((service) => service.conversation.clear(foreground)),
      clearTurnError: () =>
        runForeground((service) => service.conversation.dismissTurnError(foreground)),
      select: (id: string) =>
        runForeground((service) => service.interactions.selectQuestion(foreground, id)),
      setQuestionDraft: (id: string, draft: QuestionDraft) =>
        runForeground((service) => service.interactions.setQuestionDraft(foreground, id, draft)),
      decidePermission: (id: string, optionId: string) =>
        run(
          (service, owner) => service.interactions.decidePermission(owner, id, optionId),
          undefined,
        ),
      cancelPermission: (id: string) =>
        run((service, owner) => service.interactions.cancelPermission(owner, id), undefined),
      submitAnswers: (
        id: string,
        selections: readonly (readonly string[])[],
        notes?: readonly (string | undefined)[],
      ) =>
        run(
          (service, owner) =>
            service.interactions.submitAnswers(owner, id, selections, notes),
          undefined,
        ),
      cancelQuestions: (id: string) =>
        run((service, owner) => service.interactions.cancelQuestions(owner, id), undefined),
      sendPrompt: (text: string, attachments?: readonly ContentBlock[]) =>
        run((service, owner) => service.conversation.send(owner, text, attachments), false),
      enqueuePrompt: (text: string, attachments?: readonly ContentBlock[]) =>
        run(
          (service, owner) => service.conversation.enqueue(owner, text, attachments),
          false,
        ),
      requestCancel: () =>
        run((service, owner) => service.conversation.cancel(owner), undefined),
      retryLastPrompt: () =>
        run((service, owner) => service.conversation.retry(owner), undefined),
      resumeQueue: () =>
        run((service, owner) => service.conversation.continueQueue(owner), undefined),
      clearQueue: () =>
        run((service, owner) => service.conversation.clearQueue(owner), undefined),
      removeQueuedPrompt: (index: number) =>
        run(
          (service, owner) => service.conversation.removeQueuedPrompt(owner, index),
          undefined,
        ),
      switchModel: (id: string) =>
        run((service, owner) => service.conversation.switchModel(owner, id), undefined),
      switchMode: (id: string) =>
        run((service, owner) => service.conversation.switchMode(owner, id), undefined),
    };
  }, [workspacePath, agentKey, sessionId, view]);
}
