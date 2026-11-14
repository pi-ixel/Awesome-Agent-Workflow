/**
 * 检视器的「处置」页（ADR 031）：对一条节点记录做人工干预。
 *
 * - 重跑这一步 / 回退到这一步：选「保留成果返工」或「丢弃重做」，可附意见；
 * - 跳过这一步、改从指定步骤继续（同一流程里）；
 * - 采用 Agent 已提交的结果继续（结果未被流程接受时）。
 *
 * 执行前先向引擎要预览：会作废哪些节点、删哪些声明过的文件、哪些撤不回、
 * 哪些角色开新会话；越过撤不回的节点要额外勾选。执行后接着继续运行。
 * 运行在执行时不能处置——先在头部停止。
 */
import { errorLine } from "../status/errorText.ts";
import { useEffect, useMemo, useState } from "react";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  InterventionOutcome,
  InterventionRequest,
  WorkflowCatalog,
  WorkflowService,
} from "../types.ts";
import { disposeActions, gotoTargets, type DisposeAction as Action, type DisposeCandidate } from "./dispose.ts";
import { CheckSquare, Listbox } from "../../../shared/ui/controls.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./buttons.ts";
import { settingsTextareaClass } from "../../../shared/ui/SettingsPageParts.tsx";

const ACTION_LABEL: Record<Action, string> = {
  rerun: "重跑这一步",
  rewind: "回退到这一步",
  goto: "跳过，改从别的步骤继续",
  accept: "采用已提交的结果",
};

export function DisposePanel({ service, runId, snapshot, catalog, record, candidates, onDone, onCancel }: {
  service: WorkflowService;
  runId: string;
  snapshot: CanvasSnapshot | null;
  catalog: WorkflowCatalog | null;
  record: CanvasNodeSnapshot;
  candidates: readonly DisposeCandidate[];
  /** 处置完成：附带要告诉用户的话（清理失败等），没有则为空。 */
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const actions = disposeActions(snapshot, record, candidates.length);
  const [action, setAction] = useState<Action | undefined>(actions[0]);
  const [mode, setMode] = useState<"keep" | "discard">("keep");
  const [step, setStep] = useState("");
  const [note, setNote] = useState("");
  const [candidate, setCandidate] = useState(0);
  // 预览按请求键存：选项变了旧预览自动失效，不在 effect 里同步改状态。
  const [previewState, setPreviewState] = useState<{ key: string; outcome?: InterventionOutcome; error?: string }>({ key: "" });
  const [acknowledgedKey, setAcknowledgedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checkpoint = snapshot?.checkpoints?.find((item) => item.seq === record.checkpoint);
  const targets = useMemo(() => gotoTargets(catalog, checkpoint?.phase ?? record.phaseId ?? ""), [catalog, checkpoint, record.phaseId]);
  const chosen = action !== undefined && actions.includes(action) ? action : actions[0];

  const request: InterventionRequest | null = !checkpoint || chosen === undefined || chosen === "accept" ? null
    : chosen === "goto"
      ? (step ? { kind: "goto", checkpoint: checkpoint.seq, step, note: note.trim() } : null)
      : { kind: "rewind", checkpoint: checkpoint.seq, mode, note: note.trim() };
  const requestKey = request ? JSON.stringify({ ...request, note: "" }) : "";

  // 选项一变就重新预览（备注不影响影响面，不触发）。
  useEffect(() => {
    if (requestKey === "") return;
    let live = true;
    const parsed = JSON.parse(requestKey) as InterventionRequest;
    service.intervene(runId, parsed, { preview: true })
      .then((outcome) => { if (live) setPreviewState({ key: requestKey, outcome }); })
      .catch((cause: unknown) => {
        if (live) setPreviewState({ key: requestKey, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      live = false;
    };
  }, [service, runId, requestKey]);
  const preview = previewState.key === requestKey ? previewState.outcome ?? null : null;
  const previewError = previewState.key === requestKey ? previewState.error ?? "" : "";
  const acknowledged = acknowledgedKey !== "" && acknowledgedKey === requestKey;

  if (actions.length === 0) {
    return <div className="workflow-reconcile">
      <h4>处置</h4>
      <p>{record.mark === "superseded" ? "这条记录已被回退作废，只供回看。" : "这条记录所在的步骤已经不在当前执行路线上，不能从这里处置；可以选它之后仍在执行的节点。"}</p>
      <div className="workflow-reconcile-actions"><button type="button" className={secondaryButton} onClick={onCancel}>返回</button></div>
    </div>;
  }

  const plan = preview?.plan;
  const needsAck = (plan?.irreversible.length ?? 0) > 0;
  const active = snapshot?.active === true;
  const ready = chosen === "accept" ? candidates.length > 0 : request !== null && plan !== undefined;
  const disabled = busy || active || !ready || (needsAck && !acknowledged);

  async function execute(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      let message = "";
      if (chosen === "accept") {
        const picked = candidates[candidate] ?? candidates[0];
        await service.reconcile(runId, `${record.siteId}#${record.ordinal}`, {
          executed: true,
          result: picked?.result ?? null,
          evidence: "用户在 Desktop 采用了 Agent 已提交的结果",
        });
      } else if (request) {
        const outcome = await service.intervene(runId, request);
        if (outcome.cleanupProblems.length > 0) {
          message = `有 ${outcome.cleanupProblems.length} 个文件没能删除：${outcome.cleanupProblems.map((p) => `${p.entry}（${p.message}）`).join("；")}`;
        }
      }
      try {
        await service.resume(runId);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        message = [message, `已处置，但运行没能继续（${reason}）：还有别的节点需要先处理。`].filter(Boolean).join("\n");
      }
      onDone(message);
    } catch (cause) {
      setError(errorLine(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="workflow-reconcile workflow-dispose">
    <h4>处置</h4>
    {chosen !== undefined && <SegmentedControl<Action>
      groupLabel="处置方式"
      value={chosen}
      onChange={setAction}
      options={actions.map((item) => ({ value: item, label: ACTION_LABEL[item] }))}
    />}

    {(chosen === "rerun" || chosen === "rewind") && <>
      <SegmentedControl
        groupLabel="已有成果"
        value={mode}
        onChange={setMode}
        options={[{ value: "keep", label: "保留成果返工" }, { value: "discard", label: "丢弃重做" }]}
      />
      <p className="workflow-muted">{mode === "keep" ? "不删文件，沿用原会话，在已有成果上按意见修改。" : "按节点声明删除文件，开新会话从头做。"}</p>
      <label>给重做这一步的意见（可不填）<textarea className={settingsTextareaClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：改用事件驱动；补上错误处理" /></label>
    </>}

    {chosen === "goto" && <>
      <div className="workflow-field">下一步改为
        <Listbox
          label="下一步改为"
          value={step || null}
          placeholder="选择步骤…"
          options={targets.map((target) => ({ value: target.id, label: target.label }))}
          onChange={setStep}
          fullWidth
        />
      </div>
      <label>说明（可不填，会告诉下一步的节点）<textarea className={settingsTextareaClass} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </>}

    {chosen === "accept" && <>
      <p>这一步的 Agent 提交过结果，但流程没有接受（例如运行中断或结果不合格）。核对后可以按它继续。</p>
      {candidates.length > 1 && <div className="workflow-field">选用第几份
        <Listbox
          label="选用第几份"
          value={String(candidate)}
          options={candidates.map((_, index) => ({ value: String(index), label: `第 ${index + 1} 份` }))}
          onChange={(value) => setCandidate(Number(value))}
          fullWidth
        />
      </div>}
      <pre className="workflow-dispose-result">{JSON.stringify(candidates[candidate]?.result ?? null, null, 2)}</pre>
    </>}

    {previewError && <p className="attention">{previewError}</p>}
    {plan && <section className="workflow-dispose-preview" aria-label="处置影响">
      {plan.superseded.length > 0 && <p>作废 {plan.superseded.length} 条节点记录（保留可回看）：{unique(plan.superseded.map((n) => n.label)).join("、")}</p>}
      {plan.skipped.length > 0 && <p>跳过正在执行的：{unique(plan.skipped.map((n) => n.label)).join("、")}</p>}
      {mode === "discard" && chosen !== "goto" && (plan.cleanup.length > 0
        ? <div>
          <p>删除这些文件：</p>
          <ul>{plan.cleanup.map((file) => <li key={file.path} className={file.kind === "missing" ? "muted" : undefined}>{file.path}{file.kind === "dir" ? "（目录）" : file.kind === "missing" ? "（已不存在）" : ""}</li>)}</ul>
        </div>
        : <p>没有节点声明要删除的文件；旧文件会留在原处，重做时由节点自行处理。</p>)}
      {plan.cleanupProblems.length > 0 && <p className="attention">有 {plan.cleanupProblems.length} 个清理条目不会执行：{plan.cleanupProblems.map((p) => `${p.entry}（${p.message}）`).join("；")}</p>}
      {plan.sessions.length > 0 && <p>这些角色改开新会话：{plan.sessions.join("、")}</p>}
      {needsAck && <label className="workflow-dispose-ack attention">
        <input type="checkbox" className="peer sr-only" checked={acknowledged} onChange={(e) => setAcknowledgedKey(e.target.checked ? requestKey : "")} />
        <CheckSquare checked={acknowledged} />
        <span>这些节点的影响撤不回，重做会再来一次：{plan.irreversible.map((n) => `${n.label}（${n.reason}）`).join("；")}。我知道了</span>
      </label>}
    </section>}

    {active && <p className="attention">运行正在执行，先在上方停止运行再处置。</p>}
    {error && <p className="attention">{error}</p>}
    <div className="workflow-reconcile-actions">
      <button type="button" className={ghostButton} onClick={onCancel}>取消</button>
      <button type="button" className={primaryButton} disabled={disabled} onClick={() => void execute()}>{busy ? "处理中…" : "执行并继续运行"}</button>
    </div>
  </div>;
}

const unique = (items: readonly string[]): string[] => [...new Set(items)];
