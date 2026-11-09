import { panelError } from "../../../shared/panelError.ts";
import {
  useRightPanelValue,
  readWorkbenchUi,
  readRightPanel,
  useWorkbenchLayout,
  useSessionValue,
  useConversation,
  useWorkbenchProject,
  useWorkspaceService,
} from "../../workbench/viewBindings.ts";
import { useEffect, useRef, useState } from "react";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { WorkflowService } from "../../../contracts/workflow.ts";
import EntryWizard, { type WizardMemory } from "./EntryWizard.tsx";
import type { AawEntryId } from "../entryWizard.ts";
import AawStatusPanel from "./AawStatusPanel.tsx";
import type { WizardSubmitResult } from "./wizardSubmit.ts";
import { sendAawToTarget } from "./aawTarget.ts";

const noSessions: readonly { id: string; title: string }[] = [];
export function AawPanel({
  project,
  visible,
  drafts,
  launch,
  workflow,
}: {
  project: string;
  visible: boolean;
  drafts: Map<string, WizardMemory>;
  launch: { id: number; entry: AawEntryId } | null;
  workflow: Pick<WorkflowService, "isActive" | "submit">;
}) {
  const workbenchLayout = useWorkbenchLayout();
  const segment = useRightPanelValue(
    (state) =>
      state.projects[pathKey(project)]?.toolViews?.aaw === "launch"
        ? "launch"
        : "progress",
  );
  const projectService = useWorkbenchProject();
  const workspaceState = useWorkspaceService();
  const foregroundSession = useConversation()?.session;
  const [pending, setPending] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolveRef = useRef<((result: WizardSubmitResult) => void) | null>(
    null,
  );
  const sessions = useSessionValue(
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
      return await sendAawToTarget(
        projectService,
        workflow,
        workbenchLayout,
        project,
        selected,
        prompt,
      );
    } catch (cause) {
      return { ok: false, reason: panelError(cause) };
    } finally {
      setBusy(false);
    }
  };
  const submit = async (prompt: string): Promise<WizardSubmitResult> => {
    const ui = readWorkbenchUi(workbenchLayout);
    const workspace = workspaceState?.getState();
    const session = foregroundSession?.getState();
    if (!session) return { ok: false, reason: "项目服务尚未就绪" };
    if (session.openingSessionId !== null || session.isConnecting)
      return { ok: false, reason: "会话正在切换，请完成后重试" };
    if (
      ui.treeView === "session" &&
      pathKey(workspace?.activePath ?? "") === pathKey(project) &&
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
              readRightPanel(workbenchLayout).setToolView(project, "aaw", id)
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
            key={launch?.id ?? "default"}
            drafts={drafts}
            draftKey={pathKey(project)}
            onSubmitPrompt={submit}
            hasActiveSession={true}
            initialEntry={launch?.entry}
            onViewSession={() => {
              if (
                pathKey(readWorkbenchUi(workbenchLayout).contextPath ?? "") !==
                pathKey(project)
              )
                return;
              readWorkbenchUi(workbenchLayout).openSessionView(project);
              readRightPanel(workbenchLayout).collapse(project);
            }}
          />
        </div>
      </div>
    </div>
  );
}
