import {
  useSessionValue,
  useConversation,
  useWorkbenchProject,
  WorkbenchContext,
  useWorkspaceValue,
} from "../../../workbench/viewBindings.ts";
import { useContext, useMemo } from "react";
import type { ProjectService } from "../../../../contracts/project.ts";
import type { ContentBlock } from "../../../../contracts/acpProtocol.ts";

/** Capture the rendered owner: a late callback must never act on another session. */
export function useSessionCommands() {
  const workbench = useContext(WorkbenchContext);
  const project = useWorkbenchProject();
  const foregroundSession = useConversation()?.session;
  const workspacePath = useWorkspaceValue((state) => state.activePath);
  const agentKey = useSessionValue((state) => state.agentKey);
  const sessionId = useSessionValue((state) => state.activeSessionId);
  return useMemo(() => {
    const target =
      workspacePath && agentKey ? { workspacePath, agentKey, sessionId } : null;
    const run = <T>(
      action: (service: ProjectService, owner: NonNullable<typeof target>) => T,
      fallback: T,
    ): T => {
      if (
        !target ||
        !project ||
        workbench?.getSnapshot().project[0]?.service !== project
      )
        return fallback;
      try {
        return action(project, target);
      } catch (error) {
        const current = foregroundSession?.getState();
        if (
          current?.agentKey === agentKey &&
          current?.activeSessionId === sessionId &&
          workbench.getSnapshot().project[0]?.service === project &&
          project.workspace.getState().activePath === workspacePath
        )
          current?.setLastError(error instanceof Error ? error.message : String(error));
        return fallback;
      }
    };
    return {
      decidePermission: (id: string, optionId: string) =>
        run(
          (service, owner) => service.decidePermission(owner, id, optionId),
          undefined,
        ),
      cancelPermission: (id: string) =>
        run((service, owner) => service.cancelPermission(owner, id), undefined),
      submitAnswers: (
        id: string,
        selections: readonly (readonly string[])[],
        notes?: readonly (string | undefined)[],
      ) =>
        run(
          (service, owner) =>
            service.submitAnswers(owner, id, selections, notes),
          undefined,
        ),
      cancelQuestions: (id: string) =>
        run((service, owner) => service.cancelQuestions(owner, id), undefined),
      sendPrompt: (text: string, attachments?: readonly ContentBlock[]) =>
        run((service, owner) => service.send(owner, text, attachments), false),
      enqueuePrompt: (text: string, attachments?: readonly ContentBlock[]) =>
        run(
          (service, owner) => service.enqueue(owner, text, attachments),
          false,
        ),
      requestCancel: () =>
        run((service, owner) => service.cancel(owner), undefined),
      retryLastPrompt: () =>
        run((service, owner) => service.retry(owner), undefined),
      resumeQueue: () =>
        run((service, owner) => service.continueQueue(owner), undefined),
      clearQueue: () =>
        run((service, owner) => service.clearQueue(owner), undefined),
      removeQueuedPrompt: (index: number) =>
        run(
          (service, owner) => service.removeQueuedPrompt(owner, index),
          undefined,
        ),
      switchModel: (id: string) =>
        run((service, owner) => service.switchModel(owner, id), undefined),
      switchMode: (id: string) =>
        run((service, owner) => service.switchMode(owner, id), undefined),
    };
  }, [workspacePath, agentKey, sessionId, project, workbench, foregroundSession]);
}
