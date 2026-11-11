import { useSessionValue, useConversation } from "../../ui/bindings/conversationView.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useProjectView, type ProjectViewBinding } from "../../ui/bindings/projectView.tsx";
import { useEffect, useState } from "react";
import { RefreshIcon } from "../../../../shared/ui/icons.tsx";
import { btnSecondary } from "../../../../shared/ui/controls.tsx";
import { ConfirmationDialog } from "../../../../shared/ui/ConfirmationDialog.tsx";

export function SessionReconnect() {
  const canReconnect = useSessionValue(
    (state) =>
      (state.isBound || !!state.connectionFailure) &&
      !!state.activeSessionId &&
      !state.openingSessionId,
  );
  return canReconnect ? <ReconnectButton iconOnly /> : null;
}

export function ReconnectButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const view = useProjectView();
  const project = view?.project;
  const foregroundSession = useConversation()?.session;
  const sessionId = useSessionValue((state) => state.activeSessionId);
  const agentKey = useSessionValue((state) => state.agentKey);
  const path = useWorkspaceValue((state) => state.activePath);
  const [target, setTarget] = useState<{
    sessionId: string | null;
    path: string | null;
    agentKey?: string;
    view: ProjectViewBinding;
  } | null>(null);
  useEffect(() => {
    const offSession = foregroundSession?.subscribe((next, previous) => {
      if (
        next.activeSessionId !== previous.activeSessionId ||
        next.agentKey !== previous.agentKey
      )
        setTarget(null);
    });
    const offWorkspace = project?.projects.workspace.subscribe((next, previous) => {
      if (next.activePath !== previous.activePath) setTarget(null);
    });
    return () => {
      offSession?.();
      offWorkspace?.();
    };
  }, [project, foregroundSession]);
  const current =
    target !== null &&
    target.view === view &&
    target.sessionId === sessionId &&
    target.path === path &&
    target.agentKey === agentKey;
  return (
    <>
      <button
        type="button"
        aria-label={iconOnly ? "断开并重连" : "立即重连"}
        title="断开并重连"
        className={
          iconOnly
            ? "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover"
            : `${btnSecondary} h-8 px-3 text-sm`
        }
        disabled={!view}
        onClick={() => {
          if (view?.isActive()) setTarget({ sessionId, path, agentKey, view });
        }}
      >
        {iconOnly ? <RefreshIcon className="h-4 w-4" /> : "立即重连"}
      </button>
      {current ? (
        <ConfirmationDialog
          label="确认断开并重连"
          title="确认重连？"
          confirmLabel="确认重连"
          onCancel={() => setTarget(null)}
          onConfirm={() => {
            const state = foregroundSession?.getState();
            const { project, isActive } = target.view;
            if (
              state?.activeSessionId === target.sessionId &&
              project.projects.workspace.getState().activePath === target.path &&
              state.agentKey === target.agentKey &&
              isActive() &&
              target.path &&
              target.sessionId &&
              target.agentKey
            ) {
              const owner = {
                workspacePath: target.path,
                sessionId: target.sessionId,
                agentKey: target.agentKey,
              };
              void Promise.resolve()
                .then(() => {
                  if (isActive()) return project.sessions.recoverSession(owner);
                })
                .catch((error: unknown) => {
                  if (isActive())
                    project.conversation.reportCommandFailure(owner, String(error));
                });
            }
            setTarget(null);
          }}
        >
          <p className="text-warn-ink">
            重连会停止同一连接上的任务。未完成消息不会自动重发，消息队列保持暂停。
          </p>
        </ConfirmationDialog>
      ) : null}
    </>
  );
}
