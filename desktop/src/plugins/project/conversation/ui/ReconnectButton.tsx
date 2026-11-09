import {
  useSessionValue,
  useConversation,
  useWorkspaceValue,
  useWorkbenchProject,
  WorkbenchContext,
} from "../../../workbench/viewBindings.ts";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectService } from "../../../../contracts/project.ts";
import { RefreshIcon } from "../../../../shared/ui/icons.tsx";
import { btnDanger, btnSecondary } from "../../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../../shared/ui/ModalShell.tsx";

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
  const workbench = useContext(WorkbenchContext);
  const project = useWorkbenchProject();
  const foregroundSession = useConversation()?.session;
  const sessionId = useSessionValue((state) => state.activeSessionId);
  const agentKey = useSessionValue((state) => state.agentKey);
  const path = useWorkspaceValue((state) => state.activePath);
  const [target, setTarget] = useState<{
    sessionId: string | null;
    path: string | null;
    agentKey?: string;
    project: ProjectService;
  } | null>(null);
  useEffect(() => {
    const offSession = foregroundSession?.subscribe((next, previous) => {
      if (
        next.activeSessionId !== previous.activeSessionId ||
        next.agentKey !== previous.agentKey
      )
        setTarget(null);
    });
    const offWorkspace = project?.workspace.subscribe((next, previous) => {
      if (next.activePath !== previous.activePath) setTarget(null);
    });
    return () => {
      offSession?.();
      offWorkspace?.();
    };
  }, [project, foregroundSession]);
  const current =
    target !== null &&
    target.project === project &&
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
        disabled={!project}
        onClick={() => {
          if (project) setTarget({ sessionId, path, agentKey, project });
        }}
      >
        {iconOnly ? <RefreshIcon className="h-4 w-4" /> : "立即重连"}
      </button>
      {current
        ? createPortal(
            <ModalShell
              label="确认断开并重连"
              onDismiss={() => setTarget(null)}
            >
              <div className="p-5">
                <h2 className="text-lg font-semibold text-ink">确认重连？</h2>
                <p className="my-4 rounded-lg border border-danger-line bg-danger-bg p-3 text-sm leading-relaxed text-danger-ink">
                  重连会停止同一连接上的任务。未完成消息不会自动重发，消息队列保持暂停。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    autoFocus
                    type="button"
                    className={`${btnSecondary} h-9 px-4 text-sm`}
                    onClick={() => setTarget(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={`${btnDanger} h-9 px-4 text-sm`}
                    onClick={() => {
                      const state = foregroundSession?.getState();
                      if (
                        state?.activeSessionId === target.sessionId &&
                        target.project.workspace.getState().activePath ===
                          target.path &&
                        state.agentKey === target.agentKey &&
                        workbench?.getSnapshot().project[0]?.service ===
                          target.project &&
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
                          .then(() => target.project.recoverSession(owner))
                          .catch((error: unknown) => {
                            const current = foregroundSession?.getState();
                            if (
                              current?.activeSessionId === target.sessionId &&
                              workbench.getSnapshot().project[0]?.service ===
                                target.project &&
                              current.agentKey === target.agentKey &&
                              target.project.workspace.getState().activePath ===
                                target.path
                            )
                              current.setLastError(String(error));
                          });
                      }
                      setTarget(null);
                    }}
                  >
                    确认重连
                  </button>
                </div>
              </div>
            </ModalShell>,
            document.body,
          )
        : null}
    </>
  );
}
