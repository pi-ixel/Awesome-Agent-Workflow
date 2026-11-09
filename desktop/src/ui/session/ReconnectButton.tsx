import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { recoverDesktopSession } from "../../runtime/mainRuntime.ts";
import { RefreshIcon } from "../icons.tsx";
import { btnDanger, btnSecondary } from "../controls.tsx";
import { ModalShell } from "../workbench/ModalShell.tsx";

export function ReconnectButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const sessionId = useSessionStore((state) => state.activeSessionId);
  const agentKey = useSessionStore((state) => state.agentKey);
  const path = useWorkspaceStore((state) => state.activePath);
  const [target, setTarget] = useState<{
    sessionId: string | null;
    path: string | null;
    agentKey?: string;
  } | null>(null);
  useEffect(() => {
    const offSession = useSessionStore.subscribe((next, previous) => {
      if (
        next.activeSessionId !== previous.activeSessionId ||
        next.agentKey !== previous.agentKey
      )
        setTarget(null);
    });
    const offWorkspace = useWorkspaceStore.subscribe((next, previous) => {
      if (next.activePath !== previous.activePath) setTarget(null);
    });
    return () => {
      offSession();
      offWorkspace();
    };
  }, []);
  const current =
    target !== null &&
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
        onClick={() => setTarget({ sessionId, path, agentKey })}
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
                      const state = useSessionStore.getState();
                      if (
                        state.activeSessionId === target.sessionId &&
                        useWorkspaceStore.getState().activePath ===
                          target.path &&
                        state.agentKey === target.agentKey &&
                        target.path &&
                        target.sessionId &&
                        target.agentKey
                      )
                        void recoverDesktopSession({
                          workspacePath: target.path,
                          sessionId: target.sessionId,
                          agentKey: target.agentKey,
                        }).catch((error: unknown) => {
                          const current = useSessionStore.getState();
                          if (
                            current.activeSessionId === target.sessionId &&
                            current.agentKey === target.agentKey &&
                            useWorkspaceStore.getState().activePath ===
                              target.path
                          )
                            useSessionStore.setState({
                              lastError: String(error),
                            });
                        });
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
