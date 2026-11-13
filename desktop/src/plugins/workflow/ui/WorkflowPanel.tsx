/**
 * 流程运行面板（ADR 024 §5 ④；移植自 commit 24877d9 的
 * src/ui/right-panel/WorkflowPanel.tsx）。
 *
 * 移植适配（本批次的核心改动面）：
 * - 数据源从「直接 request 引擎方法」改为 **props 注入的 WorkflowService**：
 *   运行列表走 `service.runs()`（服务随引擎事件刷新），画布快照走
 *   `service.snapshot(runId)` 的每 runId 只读快照流，动作（停止/解除占用/
 *   继续运行/核验）走服务的 authorizeRetry/reconcile/stop/recover/resume；
 * - 节点状态推导抽到 status/snapshot.ts 纯函数（D8 修复原样保留；
 *   WorkflowHierarchy 的 siteState 复用同一函数）；
 * - 「关联会话」区从面板内只读会话流改为 **打开中央 SessionView**（ADR 024
 *   §9 开放问题 1 收口）：节点会话经 adoptExternalSession 收养进标准会话
 *   体系，点击「打开会话」走 openSession 回调入主区（侧栏同步出现）；
 * - 删除旧 stores/、core/workflowService、workflowFocus（侧栏定位）依赖；
 *   类名与样式保持（workflowPanel.css）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  RunSummary,
  WorkflowCatalog,
  WorkflowService,
} from "../types.ts";
import {
  failureLabel,
  nodeStatus,
  recordStatus,
  statusLabel,
} from "../status/snapshot.ts";
import { WorkflowHierarchy } from "./WorkflowHierarchy.tsx";
import { WorkflowLauncher } from "./WorkflowLauncher.tsx";
import "./workflowPanel.css";

type ActorRecord = CanvasSnapshot["actors"][number];

/** 节点详情候选结果（引擎 result_candidates 的宽容形状）。 */
interface ResultCandidate {
  readonly id: string;
  readonly result: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

function candidateOf(value: unknown): ResultCandidate | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    id: typeof record.id === "string" ? record.id : "",
    result: record.result ?? null,
  };
}

export function WorkflowPanel({ service, onOpenSession }: {
  service: WorkflowService;
  /** 节点会话 → 中央 SessionView（project.sessions.openSessionFromEntry）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [runId, setRunId] = useState("");
  const [selected, setSelected] = useState("");
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [selectedCallPath, setSelectedCallPath] = useState<string[]>([]);
  const [selectedPhase, setSelectedPhase] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showReconcile, setShowReconcile] = useState(false);
  const [verifiedResult, setVerifiedResult] = useState("");
  const [evidence, setEvidence] = useState("");
  const [candidateResult, setCandidateResult] = useState<{ siteId: string; ordinal: number; result: unknown } | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<"completed" | "not-executed">("completed");
  const [follow, setFollow] = useState(true);
  const [stream, setStream] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRun = useRef("");
  const [runs, setRuns] = useState<readonly RunSummary[]>(() => service.runs());
  const store = useMemo(() => (runId === "" ? undefined : service.snapshot(runId)), [service, runId]);
  const snapshot = useRegisteredSnapshot(store, (value) => value ?? null);

  useEffect(() => {
    currentRun.current = runId;
  }, [runId]);

  // 服务事件泵：列表/快照由服务刷新，这里同步 runs 缓存与面板局部态。
  useEffect(() => {
    let live = true;
    // 挂载即刷新一次：服务启动失败（列表拉取抛错）在此呈现为面板错误。
    service.refresh()
      .then(() => {
        if (live) setRuns(service.runs());
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    const unsubscribe = service.subscribe((event) => {
      if (!live) return;
      if (event.type === "service-exit") {
        setError(`工作流服务已退出（code=${typeof event.code === "number" ? event.code : "未知"}）；点「刷新」重启服务。启动诊断见应用数据目录 workflow-engine/service-stderr.log。`);
        return;
      }
      if (event.type === "snapshot-error") {
        setError(typeof event.message === "string" && event.message !== "" ? event.message : "运行快照刷新失败");
        return;
      }
      if (event.type === "run-error") {
        setError(typeof event.message === "string" && event.message !== "" ? event.message : "运行失败");
      }
      if (event.type === "acp-event") {
        const instance = event.instance as { siteId?: unknown; ordinal?: unknown } | undefined;
        const update = event.event as { type?: unknown; text?: unknown } | undefined;
        const siteId = typeof instance?.siteId === "string" ? instance.siteId : null;
        const ordinal = typeof instance?.ordinal === "number" ? instance.ordinal : null;
        if (siteId !== null && ordinal !== null && update?.type === "agent_message_chunk" && typeof update.text === "string") {
          const key = `${siteId}@${ordinal}`;
          const chunk = update.text;
          setStream((previous) => ({ ...previous, [key]: ((previous[key] ?? "") + chunk).slice(-32000) }));
        }
      }
      setRuns(service.runs());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setRuns(service.runs());
      }, 200);
    });
    return () => {
      live = false;
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [service]);

  // 默认选最近一次运行（服务按 bindWorkspace 作用域刷新列表）。
  useEffect(() => {
    if (!currentRun.current && runs[0]) setRunId(runs[0].runId);
  }, [runs]);

  // 画布目录取自运行快照里捕获的定义（对齐旧面板：snapshot.catalog 覆盖）。
  useEffect(() => {
    if (snapshot?.catalog) setCatalog(snapshot.catalog);
  }, [snapshot]);

  // 运行切换：视图重置在渲染期完成（React adjust-state-during-render）。
  const [renderedRunId, setRenderedRunId] = useState("");
  if (renderedRunId !== runId) {
    setRenderedRunId(runId);
    setStream({});
    setSelected("");
    setShowReconcile(false);
    setCandidateResult(null);
  }

  const byId = useMemo(() => new Map(catalog?.nodes.map((node) => [node.id, node]) ?? []), [catalog]);
  const runningId = snapshot?.active ? snapshot.nodes.find((item) => item.status === "running")?.siteId : undefined;
  const mismatch = !!snapshot?.run?.args && !!catalog && snapshot.run.args.workflowRevision !== catalog.revision;
  const selectedRecords = snapshot?.nodes.filter((item) =>
    item.siteId === selected &&
    (selectedPhase === undefined || item.phaseId === selectedPhase) &&
    selectedCallPath.every((id, index) => item.callPath?.[index] === id),
  ).sort((a, b) => b.ordinal - a.ordinal) ?? [];
  const node = byId.get(selected);
  const state = nodeStatus(node ?? { id: "" }, snapshot ? { ...snapshot, nodes: selectedRecords } : null);
  const lastRecord = selectedRecords[0];
  const output = lastRecord?.result ?? (lastRecord ? stream[`${lastRecord.siteId}@${lastRecord.ordinal}`] : undefined);
  // 停摆后第一个结果未知的动作：横幅的「去处理」直达它的核验面板。
  const stuckRecord = snapshot && !snapshot.active ? snapshot.nodes.find((item) => item.status === "running" || item.status === "failed") : undefined;
  const uncertain = snapshot?.nodes.filter((item) => (item.status === "running" || item.status === "failed") && (item.kind === "ask" || item.kind === "world-run")) ?? [];
  const withoutAuthorization = uncertain.filter((item) => !snapshot?.retries?.some((retry) => retry.siteId === item.siteId && retry.ordinal === item.ordinal));

  async function run(cause: () => Promise<unknown>): Promise<void> {
    setError("");
    try {
      await cause();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function reload(): Promise<void> {
    setError("");
    try {
      await service.refresh();
      setRuns(service.runs());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function reconcile(): Promise<void> {
    const record = selectedRecords.find((item) => item.status === "running" || item.status === "failed");
    if (!record || !evidence.trim()) {
      setError("请选择待核验动作并填写核验证据。");
      return;
    }
    const site = `${record.siteId}#${record.ordinal}`;
    if (recoveryMode === "not-executed") {
      if (await commit(() => service.authorizeRetry(runId, site, evidence.trim()))) {
        setShowReconcile(false);
        setEvidence("");
      }
      return;
    }
    let result: unknown;
    if (candidateResult !== null && candidateResult.siteId === record.siteId && candidateResult.ordinal === record.ordinal) {
      result = candidateResult.result;
    } else {
      try {
        result = JSON.parse(verifiedResult);
      } catch {
        setError("结果不是有效的 JSON。");
        return;
      }
    }
    if (await commit(() => service.reconcile(runId, site, { executed: true, result, evidence: evidence.trim() }))) {
      setShowReconcile(false);
      setVerifiedResult("");
      setEvidence("");
    }
  }

  async function commit(cause: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await cause();
      setRuns(service.runs());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const runResult = snapshot?.run ? asRecord(snapshot.run.result) : null;
  const blockedReason = typeof runResult?.reason === "string" ? runResult.reason : "";

  return <section className="workflow-panel" aria-label="流程运行">
    <header className="workflow-header"><div><strong>{catalog?.name || "工作流"}</strong><span>流程运行</span></div></header>
    <div className="workflow-toolbar"><label>运行 <select value={runId} onChange={(e) => { setRunId(e.target.value); setSelected(""); setSelectedCallPath([]); setSelectedPhase(undefined); }}><option value="">未选择运行</option>{runs.map((run) => <option key={run.runId} value={run.runId}>{run.name || run.args?.workflowId || "工作流"} · {run.runId.slice(0, 12)} · {statusLabel(run)}</option>)}</select></label><div className="workflow-tools"><button onClick={() => setFollow(!follow)} aria-pressed={follow} title="跟随正在运行的节点">◎ 跟随</button><button onClick={() => setZoom(Math.max(.5, zoom - .1))} aria-label="缩小">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(1.3, zoom + .1))} aria-label="放大">＋</button><button onClick={() => setZoom(1)}>1:1</button><button onClick={() => void reload()}>刷新</button></div></div>
    {snapshot && <div className="workflow-runbar"><span className={snapshot.active ? "workflow-live" : ""}>●</span> {snapshot.run?.status === "running" && !snapshot.active ? "运行中断，等待检查" : snapshot.run ? statusLabel(snapshot.run, catalog) : ""} <span className="workflow-run-id">{snapshot.runId}</span>{snapshot.active && <button onClick={() => void run(() => service.stop(runId))}>停止</button>}{!snapshot.active && snapshot.hasLease && <button onClick={() => void run(() => service.recover(runId, "Desktop：确认服务进程退出后解除占用"))}>检查并解除占用</button>}{!snapshot.active && !snapshot.hasLease && snapshot.run?.status === "stopped" && <button disabled={busy || withoutAuthorization.length > 0} title={withoutAuthorization.length > 0 ? "请先核验未完成动作" : ""} onClick={() => void run(() => service.resume(runId))}>继续运行</button>}</div>}
    {runResult?.status === "blocked" && blockedReason !== "" && <div className="workflow-block-reason">{blockedReason}</div>}
    {!error && snapshot?.run?.failure?.code && <div className="workflow-block-reason" role="alert">
      <div>{failureLabel(snapshot.run.failure.code)}</div>
      {snapshot.run.failure.detail !== undefined && snapshot.run.failure.detail !== null && <div className="workflow-failure-detail">{typeof snapshot.run.failure.detail === "string" ? snapshot.run.failure.detail : JSON.stringify(snapshot.run.failure.detail)}</div>}
      {stuckRecord && !snapshot.hasLease && <button onClick={() => { setSelected(stuckRecord.siteId); setShowReconcile(true); }}>去处理</button>}
    </div>}
    {error && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    <details className="workflow-launcher">
      <summary>启动新运行</summary>
      <WorkflowLauncher service={service} onStarted={(started) => setRunId(started)} />
    </details>
    {mismatch ? <div className="workflow-empty">这次运行使用了其他流程版本，当前画布不能可靠映射其节点。</div> : <div className="workflow-viewport" tabIndex={0} aria-label="横向流程画布">
      {catalog?.structure && catalog.entry ? <div style={{ zoom }}><WorkflowHierarchy key={runId || catalog.id} entry={catalog.entry} structure={catalog.structure} nodes={catalog.nodes} snapshot={snapshot} selected={selected} selectedPhase={selectedPhase} runningSite={follow ? runningId : undefined} onSelect={(site, path, phase) => { setSelected(site); setSelectedCallPath(path); setSelectedPhase(phase); setFollow(false); }} /></div> : <div className="workflow-empty">工作流服务未提供可执行流程结构，请更新或重启服务。</div>}
    </div>}
    {node && <div className="workflow-detail"><div><b>{node.label}</b><span>{node.kind === "agent" ? "Agent 动作" : node.kind === "python" ? "Python 动作" : "子流程"} · {state.label}</span></div><p>{node.steps.join(" · ")}</p>
      {node.kind === "agent" && <NodeSessions
        records={selectedRecords.filter((item) => item.kind === "ask")}
        actors={snapshot?.actors ?? []}
        onOpenSession={onOpenSession}
      />}
      {output !== undefined && <pre>{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>}
      {(lastRecord?.status === "running" || lastRecord?.status === "failed") && !snapshot?.active && (lastRecord?.candidates ?? []).map((value) => candidateOf(value)).map((candidate, index) => candidate && <details key={candidate.id || index}><summary>Agent 已提交的候选结果 {index + 1} · 尚未确认执行完成</summary><pre>{typeof candidate.result === "string" ? candidate.result : JSON.stringify(candidate.result, null, 2)}</pre>{!snapshot?.hasLease && lastRecord && <button onClick={() => { setCandidateResult({ siteId: lastRecord.siteId, ordinal: lastRecord.ordinal, result: candidate.result }); setRecoveryMode("completed"); setShowReconcile(true); }}>使用此结果进行核验</button>}</details>)}
      {(lastRecord?.status === "running" || lastRecord?.status === "failed") && (state.state === "unknown" || state.state === "retry" || state.state === "failed") && !snapshot?.hasLease && <button className="workflow-reconcile-toggle" onClick={() => { setCandidateResult(null); setShowReconcile(!showReconcile); }}>核验动作结果</button>}<button onClick={() => { setSelected(""); setShowReconcile(false); setCandidateResult(null); }} aria-label="关闭节点详情">×</button></div>}
    {showReconcile && node && <div className="workflow-start"><p>请先独立核验该动作的实际执行情况；系统不会自动验证证据。</p><label>核验结论<select value={recoveryMode} onChange={(e) => setRecoveryMode(e.target.value as "completed" | "not-executed")}><option value="completed">已完成，登记真实结果</option><option value="not-executed">确认未执行，允许重试一次</option></select></label>{recoveryMode === "completed" && (candidateResult !== null && lastRecord !== undefined && candidateResult.siteId === lastRecord.siteId && candidateResult.ordinal === lastRecord.ordinal ? <p>已选择 Agent 提交的候选结果；请核对结果和证据后登记。</p> : <label>真实输出（JSON；文本请加双引号）<textarea value={verifiedResult} onChange={(e) => setVerifiedResult(e.target.value)} /></label>)}<label>核验证据<input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="例如可核对的报告或记录位置" /></label><button onClick={() => { setShowReconcile(false); setCandidateResult(null); }}>取消</button><button onClick={() => void reconcile()}>登记核验结论</button></div>}
  </section>;
}

/** 节点详情的关联会话区（按执行轮次，最新在前）：点击「打开会话」进
 *  中央 SessionView（节点会话已由 adoptExternalSession 收养进标准会话
 *  体系，侧栏同步出现）。未执行或无归属如实显示「尚无会话」，不假装有
 *  Agent 会话（Python 节点不渲染本区）。 */
function NodeSessions({ records, actors, onOpenSession }: {
  records: readonly CanvasNodeSnapshot[];
  actors: readonly ActorRecord[];
  onOpenSession?: (sessionId: string) => void;
}) {
  const actorOf = (record: CanvasNodeSnapshot): ActorRecord | undefined =>
    actors.find((actor) => actor.siteId === record.actorSiteId && actor.ordinal === record.actorOrdinal);
  return <div className="workflow-sessions" aria-label="关联会话">
    {records.length === 0 && <span className="workflow-session-empty">尚无会话</span>}
    {records.map((record) => {
      const sessionId = actorOf(record)?.sessionId;
      return <div key={record.ordinal} className="workflow-session-row">
        <span>{Object.values(asRecord(record.scope) ?? {}).filter((value) => typeof value === "string" && value).join(" / ")}{Object.values(asRecord(record.scope) ?? {}).some((value) => typeof value === "string" && value) && " · "}第 {record.ordinal} 次 · {recordStatus(record)}</span>
        {sessionId === undefined ? <span className="workflow-session-empty">尚无会话</span> : <span className="workflow-session-actions">
          <button onClick={() => onOpenSession?.(sessionId)}>打开会话 ↗</button>
        </span>}
      </div>;
    })}
  </div>;
}
