import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { HostService } from "../../host/service.ts";
import type { ProjectService } from "../../project/service.ts";
import { needsBrowserToolRecovery } from "../../../shared/browser/toolAvailability.ts";

type BrowserMcpStatus = Awaited<
  ReturnType<HostService["browser"]["mcpStatus"]>
>;
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { btnSecondary, DangerButton } from "../../../shared/ui/controls.tsx";

export interface BrowserToolRecoveryProps {
  readonly host: HostService["browser"];
  readonly project: {
    readonly sessions: Pick<ProjectService["sessions"], "recoverSession">;
  };
  readonly workspacePath: string;
  readonly agentKey: string;
  readonly sessionId: string;
  readonly runtime: {
    readonly lastSessionId: string | null;
    readonly toolNames: readonly string[];
    readonly toolInventoryKnown?: boolean;
  };
}

export function BrowserToolRecovery(props: BrowserToolRecoveryProps) {
  return (
    <BrowserToolRecoverySession
      key={`${props.workspacePath}:${props.agentKey}:${props.sessionId}`}
      {...props}
    />
  );
}

function BrowserToolRecoverySession({
  host,
  project,
  workspacePath,
  agentKey,
  sessionId,
  runtime,
}: BrowserToolRecoveryProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [mcpStatus, setMcpStatus] = useState<BrowserMcpStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .agentControlEnabled()
      .then((actual) => {
        if (active) setEnabled(actual);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    void host
      .onAgentControl(({ enabled: actual }) => {
        if (active) setEnabled(actual);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host]);

  useEffect(() => {
    let active = true;
    void host
      .mcpStatus(sessionId)
      .then((actual) => {
        if (active) setMcpStatus(actual);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [enabled, host, runtime.toolNames, sessionId]);

  const runtimeKnown = runtime.lastSessionId === sessionId;
  const needsRecovery = needsBrowserToolRecovery({
    enabled,
    mcpStatus,
    runtimeKnown,
    toolInventoryKnown: runtime.toolInventoryKnown,
    toolNames: runtime.toolNames,
  });

  return (
    <>
      {enabled === false && (
        <section
          role="status"
          className="shrink-0 border-b border-danger-line bg-danger-bg/40 px-3 py-2 text-xs text-danger-ink"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">Agent 浏览器控制已关闭</p>
              <p className="mt-0.5 text-ink-mute">
                当前会话无法使用浏览器工具，开启后仍需确认重连。
              </p>
            </div>
            <button
              type="button"
              className={`${btnSecondary} shrink-0 px-3 py-1.5`}
              onClick={() => {
                void host
                  .setAgentControl(true)
                  .then((actual) => {
                    setEnabled(actual);
                    setError(null);
                  })
                  .catch((cause) => setError(String(cause)));
              }}
            >
              开启 Agent 浏览器控制
            </button>
          </div>
        </section>
      )}
      {needsRecovery && (
        <section
          role="status"
          className="shrink-0 border-b border-line bg-surface px-3 py-2 text-xs text-ink"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">当前会话尚未注册浏览器工具</p>
              <p className="mt-0.5 text-ink-mute">
                需要重连当前会话；工具注册以重连后的真实运行时为准。
              </p>
            </div>
            <button
              type="button"
              className={`${btnSecondary} shrink-0 px-3 py-1.5`}
              onClick={() => setConfirming(true)}
            >
              重连并恢复浏览器工具
            </button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="shrink-0 px-3 py-1 text-xs text-danger-ink">
          {error}
        </p>
      )}
      {confirming && needsRecovery
        ? createPortal(
            <ModalShell
              label="确认恢复浏览器工具"
              onDismiss={() => {
                if (!recovering) setConfirming(false);
              }}
            >
              <div className="p-5">
                <h2 className="text-ui-lg font-semibold text-ink">
                  重连并恢复浏览器工具？
                </h2>
                <p className="my-4 rounded-lg border border-danger-line bg-danger-bg p-3 text-sm leading-relaxed text-danger-ink">
                  重连会停止同一连接上的任务。未完成消息不会自动重发，消息队列保持暂停。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={`${btnSecondary} min-h-9 px-4 text-sm`}
                    disabled={recovering}
                    onClick={() => setConfirming(false)}
                  >
                    取消
                  </button>
                  <DangerButton
                    className="min-h-9 px-4 text-sm"
                    disabled={recovering}
                    onClick={() => {
                      setRecovering(true);
                      setError(null);
                      void project.sessions
                        .recoverSession({ workspacePath, agentKey, sessionId })
                        .then(() => setConfirming(false))
                        .catch((cause: unknown) => setError(String(cause)))
                        .finally(() => setRecovering(false));
                    }}
                  >
                    {recovering ? "正在重连" : "确认重连"}
                  </DangerButton>
                </div>
              </div>
            </ModalShell>,
            document.body,
          )
        : null}
    </>
  );
}
