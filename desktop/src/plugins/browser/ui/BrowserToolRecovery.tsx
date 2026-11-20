import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { HostService } from "../../host/service.ts";
import type { ProjectService } from "../../project/service.ts";
import { needsBrowserToolRecovery } from "../../../shared/browser/toolAvailability.ts";

type BrowserMcpStatus = Awaited<
  ReturnType<HostService["browser"]["mcpStatus"]>
>;
type BrowserMcpRegistration = Awaited<
  ReturnType<HostService["browser"]["mcpRegistration"]>
>;
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton, DangerButton } from "../../../shared/ui/controls.tsx";

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
    readonly mcpFailures?: readonly {
      readonly name: string;
      readonly error: string;
    }[];
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
  const [registration, setRegistration] = useState<BrowserMcpRegistration>(null);
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
    void Promise.all([
      host.mcpStatus(sessionId),
      runtime.mcpFailures
        ? host.mcpRegistration(sessionId)
        : Promise.resolve(null),
    ])
      .then(([status, current]) => {
        if (active) {
          setMcpStatus(status);
          setRegistration(current);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [
    enabled,
    host,
    recovering,
    runtime.mcpFailures,
    runtime.toolNames,
    sessionId,
  ]);

  const runtimeKnown = runtime.lastSessionId === sessionId;
  const connectionFailure =
    runtimeKnown && mcpStatus === "active" && registration
      ? runtime.mcpFailures?.find(
          ({ name }) => name === registration.endpointName,
        )
      : undefined;
  const isHandshaking =
    runtimeKnown &&
    enabled === true &&
    mcpStatus === "active" &&
    registration?.handshakeComplete === false &&
    !connectionFailure &&
    !recovering;
  const needsRecovery =
    !isHandshaking &&
    ((enabled === true && !!connectionFailure) ||
      needsBrowserToolRecovery({
        enabled,
        mcpStatus,
        runtimeKnown,
        toolInventoryKnown: runtime.toolInventoryKnown,
        toolNames: runtime.toolNames,
      }));
  const isReconnectingBrowser = recovering && runtime.mcpFailures !== undefined;

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
            <ActionButton
              tone="secondary"
              type="button"
              className="shrink-0 px-3 py-1.5"
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
            </ActionButton>
          </div>
        </section>
      )}
      {isHandshaking && (
        <p
          role="status"
          className="shrink-0 border-b border-line px-3 py-2 text-xs text-ink-mute"
        >
          正在连接本地浏览器工具…
        </p>
      )}
      {needsRecovery && (
        <section
          role="status"
          className="shrink-0 border-b border-line bg-surface px-3 py-2 text-xs text-ink"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">
                {isReconnectingBrowser
                  ? "正在连接本地浏览器工具…"
                  : connectionFailure
                    ? "本地浏览器工具连接失败"
                    : "当前会话尚未注册浏览器工具"}
              </p>
              <p className="mt-0.5 text-ink-mute">
                {isReconnectingBrowser
                  ? "正在为当前会话重新注册浏览器工具。"
                  : connectionFailure
                    ? describeConnectionFailure(connectionFailure.error)
                    : "需要重连当前会话；工具注册以重连后的真实运行时为准。"}
              </p>
            </div>
            <ActionButton
              tone="secondary"
              type="button"
              className="shrink-0 px-3 py-1.5"
              onClick={() => setConfirming(true)}
            >
              重连并恢复浏览器工具
            </ActionButton>
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
                  <ActionButton
                    tone="secondary"
                    type="button"
                    className="min-h-9 px-4 text-sm"
                    disabled={recovering}
                    onClick={() => setConfirming(false)}
                  >
                    取消
                  </ActionButton>
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

function describeConnectionFailure(error: string): string {
  const response = /\b(?:error|status(?: code)?)\s+['"]?([45]\d{2})\b/i.exec(
    error,
  );
  if (response)
    return `连接本地 MCP 服务时收到 HTTP ${response[1]}。检查代理设置后可重试连接。`;
  if (/timeout|timed? out|did not complete within/i.test(error)) {
    return "等待本地 MCP 服务响应超时。检查代理设置后可重试连接。";
  }
  return "Agent 无法完成本地 MCP 服务握手。";
}
