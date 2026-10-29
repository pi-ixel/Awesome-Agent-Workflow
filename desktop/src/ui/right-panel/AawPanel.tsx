import { useEffect, useRef, useState } from "react";
import { pathKey } from "../../core/panelPaths.ts";
import { panelError } from "../../core/panelService.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import EntryWizard from "../EntryWizard.tsx";
import AawStatusPanel from "../AawStatusPanel.tsx";
import type { WizardSubmitResult } from "../workbench/wizardSubmit.ts";
import { sendAawToTarget } from "./aawTarget.ts";
import { useRightPanelStore } from "../../stores/rightPanelStore.ts";

const noSessions: readonly { id: string; title: string }[] = [];
export function AawPanel({
  project,
  visible,
}: {
  project: string;
  visible: boolean;
}) {
  const segment = useRightPanelStore(
    (state) => state.projects[pathKey(project)]?.aawSegment ?? "progress",
  );
  const wizardRequest = useWorkbenchUiStore((state) => state.aawWizardRequest);
  const scopedWizard =
    wizardRequest && pathKey(wizardRequest.project) === pathKey(project)
      ? wizardRequest
      : null;
  useEffect(() => {
    if (
      visible &&
      segment === "launch" &&
      scopedWizard &&
      !scopedWizard.handled
    )
      useWorkbenchUiStore.getState().finishAawWizardRequest(scopedWizard.id);
  }, [visible, segment, scopedWizard]);
  const [pending, setPending] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolveRef = useRef<((result: WizardSubmitResult) => void) | null>(
    null,
  );
  const sessions = useSessionStore(
    (state) => state.sessionsByPath[project] ?? noSessions,
  );
  useEffect(
    () => () => {
      resolveRef.current?.({ ok: false, reason: "项目已切换，已取消本次发送" });
      resolveRef.current = null;
    },
    [],
  );
  const send = async (
    prompt: string,
    selected: string,
  ): Promise<WizardSubmitResult> => {
    setBusy(true);
    try {
      return await sendAawToTarget(project, selected, prompt);
    } catch (cause) {
      return { ok: false, reason: panelError(cause) };
    } finally {
      setBusy(false);
    }
  };
  const submit = async (prompt: string): Promise<WizardSubmitResult> => {
    const ui = useWorkbenchUiStore.getState();
    const workspace = useWorkspaceStore.getState();
    const session = useSessionStore.getState();
    if (session.openingSessionId !== null || session.isConnecting)
      return { ok: false, reason: "会话正在切换，请完成后重试" };
    if (
      ui.treeView === "session" &&
      pathKey(workspace.activePath ?? "") === pathKey(project) &&
      session.activeSessionId &&
      session.isBound
    )
      return send(prompt, session.activeSessionId);
    if (resolveRef.current)
      return { ok: false, reason: "请先完成当前会话选择" };
    setTarget("");
    setPending(prompt);
    setError(null);
    return new Promise<WizardSubmitResult>((resolve) => {
      resolveRef.current = resolve;
    });
  };
  const finish = (result: WizardSubmitResult): void => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setPending(null);
    if (!result.ok) setError(result.reason);
  };
  return (
    <div
      hidden={!visible}
      aria-label={visible ? "AAW 面板" : undefined}
      className={visible ? "flex h-full min-h-0 flex-col" : "hidden"}
    >
      <div
        role="tablist"
        aria-label="AAW 面板分段"
        className="flex gap-2 border-b border-line p-2 text-ui-base"
      >
        {(["progress", "launch"] as const).map((id) => (
          <button
            role="tab"
            key={id}
            aria-selected={segment === id}
            onClick={() =>
              useRightPanelStore.getState().aawSegment(project, id)
            }
            className={`rounded border border-line px-3 py-1 ${segment === id ? "bg-info-bg text-info-ink" : ""}`}
          >
            {id === "progress" ? "进度" : "启动"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && (
          <p role="alert" className="mb-2 text-ui-base text-danger-ink">
            {error}
          </p>
        )}
        {pending !== null && (
          <div
            role="dialog"
            aria-label="选择 AAW 执行会话"
            className="mb-3 space-y-3 rounded border border-info-line bg-info-bg/30 p-3 text-sm"
          >
            <p>选择此项目的执行会话</p>
            <select
              aria-label="执行会话"
              className="w-full rounded border border-line bg-base p-2"
              value={target}
              disabled={busy}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">请选择…</option>
              <option value="new">新建会话</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title || session.id}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                disabled={!target || busy}
                className="rounded border border-line px-3 py-1 disabled:opacity-40"
                onClick={() => {
                  void send(pending, target).then(finish);
                }}
              >
                {busy ? "正在连接…" : "连接并发送"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  finish({ ok: false, reason: "已取消发送，表单已保留" })
                }
              >
                取消
              </button>
            </div>
          </div>
        )}
        {segment === "progress" && visible && (
          <AawStatusPanel
            onRunCommand={(command) => {
              void submit(command).then((result) => {
                if (!result.ok) setError(result.reason);
              });
            }}
          />
        )}
        <div
          hidden={segment !== "launch"}
          className={segment === "launch" ? "" : "hidden"}
        >
          <EntryWizard
            key={scopedWizard?.id ?? "default"}
            draftKey={pathKey(project)}
            onSubmitPrompt={submit}
            hasActiveSession={true}
            initialEntry={
              scopedWizard && !scopedWizard.handled
                ? scopedWizard.entry
                : undefined
            }
            onViewSession={() => {
              if (
                pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
                pathKey(project)
              )
                return;
              useWorkbenchUiStore.getState().openSessionView(project);
              useRightPanelStore.getState().collapse(project);
            }}
          />
        </div>
      </div>
    </div>
  );
}
