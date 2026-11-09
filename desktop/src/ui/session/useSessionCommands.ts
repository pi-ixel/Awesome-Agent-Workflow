import { useMemo } from "react";
import { getDesktopAcpService } from "../../runtime/mainRuntime.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import type { AcpService } from "../../runtime/acp/service.ts";
import type { ContentBlock } from "../../runtime/acpBase/protocol/types.ts";

/** Capture the rendered owner: a late callback must never act on another session. */
export function useSessionCommands() {
  const workspacePath = useWorkspaceStore((state) => state.activePath);
  const agentKey = useSessionStore((state) => state.agentKey);
  const sessionId = useSessionStore((state) => state.activeSessionId);
  return useMemo(() => {
    const target =
      workspacePath && agentKey ? { workspacePath, agentKey, sessionId } : null;
    const run = <T>(
      action: (service: AcpService, owner: NonNullable<typeof target>) => T,
      fallback: T,
    ): T => {
      if (!target) return fallback;
      try {
        return action(getDesktopAcpService(), target);
      } catch (error) {
        const current = useSessionStore.getState();
        if (
          current.agentKey === agentKey &&
          current.activeSessionId === sessionId &&
          useWorkspaceStore.getState().activePath === workspacePath
        )
          useSessionStore.setState({
            lastError: error instanceof Error ? error.message : String(error),
          });
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
  }, [workspacePath, agentKey, sessionId]);
}
