import { describeUnknownError } from "../../../shared/errors.ts";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { useEffect, useRef, useState } from "react";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { WorkflowService } from "../service.ts";
import EntryWizard, { type WizardMemory } from "./EntryWizard.tsx";
import type { AawEntryId } from "../launch/entryWizard.ts";
import AawStatusPanel from "./AawStatusPanel.tsx";
import type { WizardSubmitResult } from "./wizardSubmit.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

type SessionChoice = { readonly id: string; readonly title: string };
export type WorkflowPanelSegment = "progress" | "launch";

export interface WorkflowSessionPicker {
  readonly sessions: ReadonlySnapshot<{
    readonly sessionsByPath: Readonly<Record<string, readonly SessionChoice[]>>;
  }>;
  current(): {
    readonly path: string | null;
    readonly sessionId: string | null;
    readonly switching: boolean;
    readonly bound: boolean;
  };
}

const noSessions: readonly SessionChoice[] = [];
export function AawPanel({
  project,
  visible,
  drafts,
  launch,
  workflow,
  sessionPicker,
  segment,
  onSelectSegment,
  sendToTarget,
  isConversationVisible,
  onViewSession,
}: {
  project: string;
  visible: boolean;
  drafts: Map<string, WizardMemory>;
  launch: { id: number; entry: AawEntryId } | null;
  workflow: Pick<WorkflowService, "status" | "refresh" | "selectSr" | "setAutoRefresh">;
  sessionPicker: WorkflowSessionPicker;
  segment: WorkflowPanelSegment;
  onSelectSegment: (segment: WorkflowPanelSegment) => void;
  sendToTarget: (target: string, prompt: string) => Promise<WizardSubmitResult>;
  isConversationVisible: () => boolean;
  onViewSession: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolveRef = useRef<((result: WizardSubmitResult) => void) | null>(
    null,
  );
  const sessions = useRegisteredSnapshot(
    sessionPicker.sessions,
    (state) => state?.sessionsByPath[project] ?? noSessions,
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
      return await sendToTarget(selected, prompt);
    } catch (cause) {
      return { ok: false, reason: describeUnknownError(cause) };
    } finally {
      setBusy(false);
    }
  };
  const submit = async (prompt: string): Promise<WizardSubmitResult> => {
    const session = sessionPicker.current();
    if (session.switching)
      return { ok: false, reason: "会话正在切换，请完成后重试" };
    if (
      isConversationVisible() &&
      pathKey(session.path ?? "") === pathKey(project) &&
      session.sessionId &&
      session.bound
    )
      return send(prompt, session.sessionId);
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
            onClick={() => onSelectSegment(id)}
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
            workflow={workflow}
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
            onViewSession={onViewSession}
          />
        </div>
      </div>
    </div>
  );
}
