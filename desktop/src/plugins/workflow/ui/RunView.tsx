/**
 * 一次运行的视图（AAW 面板第三层；外壳与导航见 WorkflowPanel.tsx）。
 *
 * 结构自上而下：
 * - **头部**：运行标题、工作流 · 起点、开始时间与用时，需求原文可展开；
 *   工具（跟随 / 缩放 / 刷新 / 再次运行）；状态词 + 阶段进度 + 当前节点 +
 *   唯一可用的运行动作；
 * - **一条横幅**：阻塞 / 中断 / 服务错误 / 版本不匹配 / 等你回复都收进同一条——
 *   首行人话原因，错误码折叠，最多一个主操作；
 * - **画布**：WorkflowHierarchy（纵向分带）。条带宽度按视口 clamp 到
 *   BAND_MIN…BAND_MAX；低于下限横向滚动并出单行提示（拉宽 / 完整视图）；
 *   离开当前节点时浮出「回到当前节点」；Ctrl+滚轮与 +/-/0 缩放；
 * - **检视器**：面板 ≥ 700px（或完整视图）放画布右侧，否则放画布下方。
 *   头部是状态、轮次圆点和「打开会话」；正文按节点处境给内容（NodeDetail），
 *   原始结果折叠在最后；需要核验时切到核验页，证据必填，登记后显示结果。
 *
 * 数据源：每 runId 快照流 `service.snapshot`，动作经 authorizeRetry /
 * reconcile / stop / recover / resume；状态词汇统一由 status/snapshot.ts 给出。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  WorkflowCatalog,
  WorkflowLaunchRequest,
  WorkflowService,
} from "../types.ts";
import {
  failureLabel,
  isSettled,
  mergeStates,
  nodeStatus,
  recordStatus,
  STATE_LABEL,
  statusLabel,
  type NodeState,
} from "../status/snapshot.ts";
import {
  BAND_MAX,
  BAND_MIN,
  CANVAS_PAD,
  LOOP_GUTTER,
  StatusWord,
  WorkflowHierarchy,
} from "./WorkflowHierarchy.tsx";
import { formatDuration, formatStart, useNow } from "./time.ts";
import { NodeDetail } from "./NodeDetail.tsx";
import { describeResult, entryConditions } from "./nodeDetail.ts";
import "./workflowPanel.css";

type ActorRecord = CanvasSnapshot["actors"][number];
type InspectorPage = "detail" | "reconcile";
/** 面板够宽时检视器放右侧（原型阈值）。 */
const WIDE_PANEL = 700;

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

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.3;
const clampZoom = (value: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 10) / 10;

export function RunView({ service, runId, onLaunch, onOpenSession, onOpenFile, onWiden, onFullView }: {
  service: WorkflowService;
  runId: string;
  /** 「再次运行」：回到启动表单，预选这次运行的工作流与起点。 */
  onLaunch?: (request: WorkflowLaunchRequest) => void;
  /** 节点会话 → 中央 SessionView（project.sessions.openSessionFromEntry）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 结果里的文件路径 → 工作台打开文件。 */
  onOpenFile?: (path: string) => void;
  /** 窄屏提示的两个出口（工作台右栏拉宽 / 进入完整视图）。 */
  onWiden?: () => void;
  onFullView?: () => void;
}) {
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [selected, setSelected] = useState("");
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [selectedCallPath, setSelectedCallPath] = useState<string[]>([]);
  const [selectedPhase, setSelectedPhase] = useState<string | undefined>();
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<InspectorPage | undefined>();
  const [verifiedResult, setVerifiedResult] = useState("");
  const [evidence, setEvidence] = useState("");
  const [candidateResult, setCandidateResult] = useState<{ siteId: string; ordinal: number; result: unknown } | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<"completed" | "not-executed">("completed");
  const [reconciled, setReconciled] = useState<{ key: string; mode: "completed" | "not-executed"; evidence: string } | null>(null);
  const [follow, setFollow] = useState(true);
  const [stream, setStream] = useState<Record<string, string>>({});
  const [viewportWidth, setViewportWidth] = useState(0);
  const [panelWidth, setPanelWidth] = useState(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const [currentHidden, setCurrentHidden] = useState(false);
  const [flashSite, setFlashSite] = useState<string | undefined>();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const store = useMemo(() => (runId === "" ? undefined : service.snapshot(runId)), [service, runId]);
  const snapshot = useRegisteredSnapshot(store, (value) => value ?? null);

  // 服务事件泵：快照由服务刷新，这里只接错误与 Agent 消息节选。
  useEffect(() => {
    let live = true;
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
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service]);

  // 用时随时间走：每 30 秒刷新一次显示。
  const now = useNow(30_000);

  // 画布目录取自运行快照里捕获的定义（运行固定在启动时的定义版本上）；
  // 渲染期派生，快照暂缺目录时保留上一份。
  if (snapshot?.catalog && snapshot.catalog !== catalog) setCatalog(snapshot.catalog);

  // 条带宽度随视口：可用宽 = 视口 − 内边距×2 − 回环导轨（规约 §6.2）。
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [catalog]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // 检视器位置随面板宽度：够宽放右侧，否则放下方。
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = () => setPanelWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 运行切换：视图重置在渲染期完成（React adjust-state-during-render）。
  const [renderedRunId, setRenderedRunId] = useState("");
  if (renderedRunId !== runId) {
    setRenderedRunId(runId);
    setStream({});
    clearSelection();
  }

  function clearSelection(): void {
    setSelected("");
    setSelectedOrdinal(undefined);
    setTab(undefined);
    setCandidateResult(null);
    setReconciled(null);
  }

  const byId = useMemo(() => new Map(catalog?.nodes.map((node) => [node.id, node]) ?? []), [catalog]);
  const runningRecord = snapshot?.active ? snapshot.nodes.find((item) => item.status === "running") : undefined;
  const runningId = runningRecord?.siteId;
  const mismatch = !!snapshot?.run?.args && !!catalog && snapshot.run.args.workflowRevision !== catalog.revision;
  const selectedRecords = snapshot?.nodes.filter((item) =>
    item.siteId === selected &&
    (selectedPhase === undefined || item.phaseId === selectedPhase) &&
    selectedCallPath.every((id, index) => item.callPath?.[index] === id),
  ).sort((a, b) => b.ordinal - a.ordinal) ?? [];
  const node = byId.get(selected);
  const record = selectedRecords.find((item) => item.ordinal === selectedOrdinal) ?? selectedRecords[0];
  const latestRecord = selectedRecords[0];
  const state = nodeStatus(node ?? { id: "" }, snapshot ? { ...snapshot, nodes: record ? [record] : [] } : null);
  const live = record ? stream[`${record.siteId}@${record.ordinal}`] : undefined;
  const candidates = (latestRecord?.status === "running" || latestRecord?.status === "failed") && !snapshot?.active
    ? (latestRecord.candidates ?? []).map((value) => candidateOf(value)).filter((item): item is ResultCandidate => item !== null)
    : [];
  const retryAuthorized = !!latestRecord && !!snapshot?.retries?.some((retry) => retry.siteId === latestRecord.siteId && retry.ordinal === latestRecord.ordinal);
  const latestState = nodeStatus(node ?? { id: "" }, snapshot ? { ...snapshot, nodes: latestRecord ? [latestRecord] : [] } : null).state;
  const reconcilable = !!latestRecord && (latestRecord.status === "running" || latestRecord.status === "failed") &&
    (latestState === "stuck" || latestState === "failed" || retryAuthorized) && !snapshot?.hasLease;
  // 停摆后第一个结果未知的动作：横幅的「去处理」直达它的核验页。
  const stuckRecord = snapshot && !snapshot.active ? snapshot.nodes.find((item) => item.status === "running" || item.status === "failed") : undefined;
  const uncertain = snapshot?.nodes.filter((item) => (item.status === "running" || item.status === "failed") && (item.kind === "ask" || item.kind === "world-run")) ?? [];
  const withoutAuthorization = uncertain.filter((item) => !snapshot?.retries?.some((retry) => retry.siteId === item.siteId && retry.ordinal === item.ordinal));
  const recordKey = latestRecord ? `${latestRecord.siteId}#${latestRecord.ordinal}` : "";
  // 检视器头部直达：当前所看轮次的节点会话（Agent 节点）。
  const recordSession = node?.kind === "agent" && record ? sessionOf(record, snapshot?.actors ?? []) : undefined;
  // 停摆且没有任何结果可看时直接进核验页；其余先看详情。
  const page: InspectorPage = tab
    ?? (reconcilable && candidates.length === 0 && record?.result == null ? "reconcile" : "detail");
  const described = describeResult(record?.result);
  // 发现已由流程接手（或运行已落定）：结论照写，但不再用警示色。
  const resultView = described?.conclusion && state.state === "done-findings"
    ? { ...described, conclusion: { ...described.conclusion, tone: "neutral" as const } }
    : described;
  const conditions = node && !record && catalog?.structure
    ? entryConditions(catalog.structure, node.id, selectedPhase, (site) => byId.get(site)?.label ?? site)
    : [];
  const wide = panelWidth >= WIDE_PANEL;

  // 跟随：当前节点变化时把它滚进视口；离开视口时浮出「回到当前节点」。
  useEffect(() => {
    const element = viewport.current;
    if (!element || !runningId) {
      setCurrentHidden(false);
      return;
    }
    const card = element.querySelector<HTMLElement>("[data-current='true']");
    if (!card) return;
    if (follow) card.scrollIntoView?.({ block: "center", behavior: "smooth" });
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => setCurrentHidden(!entry?.isIntersecting), { root: element, threshold: 0.4 });
    observer.observe(card);
    return () => observer.disconnect();
  }, [runningId, follow, snapshot]);

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function reconcile(): Promise<void> {
    const target = selectedRecords.find((item) => item.status === "running" || item.status === "failed");
    if (!target || !evidence.trim()) {
      setError("请选择待核验动作并填写核验证据。");
      return;
    }
    const site = `${target.siteId}#${target.ordinal}`;
    const proof = evidence.trim();
    if (recoveryMode === "not-executed") {
      if (await commit(() => service.authorizeRetry(runId, site, proof))) {
        setReconciled({ key: site, mode: "not-executed", evidence: proof });
        setEvidence("");
      }
      return;
    }
    let result: unknown;
    if (candidateResult !== null && candidateResult.siteId === target.siteId && candidateResult.ordinal === target.ordinal) {
      result = candidateResult.result;
    } else {
      try {
        result = JSON.parse(verifiedResult);
      } catch {
        setError("结果不是有效的 JSON。");
        return;
      }
    }
    if (await commit(() => service.reconcile(runId, site, { executed: true, result, evidence: proof }))) {
      setReconciled({ key: site, mode: "completed", evidence: proof });
      setVerifiedResult("");
      setEvidence("");
    }
  }

  async function commit(cause: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await cause();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function select(site: string, path: string[], phase?: string): void {
    if (site !== selected || phase !== selectedPhase) {
      setTab(undefined);
      setSelectedOrdinal(undefined);
      setCandidateResult(null);
      setReconciled(null);
    }
    setSelected(site);
    setSelectedCallPath(path);
    setSelectedPhase(phase);
    if (site) setFollow(false);
  }

  function openReconcile(siteId: string): void {
    select(siteId, [], undefined);
    setTab("reconcile");
    flashNode(siteId);
  }

  /** 跳转定位：把卡片滚进视口，外圈闪一下再淡掉（只在跳转时，普通点击不闪）。 */
  function flashNode(siteId: string): void {
    const card = [...(viewport.current?.querySelectorAll<HTMLElement>(".workflow-card[data-site]") ?? [])]
      .find((element) => element.dataset.site === siteId);
    card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setFlashSite(siteId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashSite(undefined), 1500);
  }

  // ------------------------------------------------------------ 派生呈现
  const runResult = snapshot?.run ? asRecord(snapshot.run.result) : null;
  const blockedReason = typeof runResult?.reason === "string" ? runResult.reason : "";
  const interrupted = snapshot?.run?.status === "running" && !snapshot.active;
  const runState: NodeState = !snapshot?.run ? "pending"
    : snapshot.active ? "running"
      : interrupted || withoutAuthorization.length > 0 ? "stuck"
        : runResult?.status === "blocked" ? "blocked"
          : snapshot.run.status === "completed" ? "done"
            : snapshot.run.status === "failed" ? "failed" : "pending";
  const runWord = !snapshot?.run ? "" : interrupted ? "运行中断，等待检查" : statusLabel(snapshot.run, catalog);
  const stages = progressStages(catalog, snapshot);
  // 一轮结束仍无结果、引擎在等用户经会话回复的节点（引擎记录的标记）。
  const awaitingRecords = snapshot?.active ? snapshot.nodes.filter((item) => item.status === "running" && item.awaitingInput === true) : [];
  const awaitingRecord = awaitingRecords[0];
  const awaiting = awaitingRecord && {
    label: byId.get(awaitingRecord.siteId)?.label ?? awaitingRecord.siteId,
    sessionId: sessionOf(awaitingRecord, snapshot?.actors ?? []),
    more: awaitingRecords.length - 1,
  };
  const awaitingSession = awaiting ? awaiting.sessionId : undefined;
  const currentLabel = (() => {
    const focus = awaitingRecord ?? runningRecord ?? stuckRecord;
    return focus ? byId.get(focus.siteId)?.label ?? focus.siteId : "";
  })();
  const banner = bannerOf({ error, snapshot, blockedReason, mismatch, stuckRecord, awaiting });
  const available = viewportWidth - CANVAS_PAD * 2 - LOOP_GUTTER;
  const bandWidth = Math.round(Math.max(BAND_MIN, Math.min(BAND_MAX, available > 0 ? available : BAND_MAX)));
  const narrow = viewportWidth > 0 && viewportWidth < BAND_MIN + CANVAS_PAD * 2 + LOOP_GUTTER;
  const summary = snapshot?.run ?? service.runs().find((item) => item.runId === runId) ?? null;
  const runName = summary?.name || catalog?.name || "工作流";
  const runTitle = summary?.title || runName;
  const settled = !snapshot?.active && summary !== null && summary.status !== "running";
  const elapsed = summary?.createdAt != null
    ? formatDuration((settled && summary.updatedAt != null ? summary.updatedAt : now) - summary.createdAt)
    : "";

  return <section className="workflow-run" aria-label="流程运行" ref={panelRef}>
    <header className="workflow-head">
      <div className="workflow-head-row">
        <div className="workflow-run-title">
          {snapshot?.run && <StatusWord state={runState} waiting={awaiting !== undefined} />}
          <b title={runTitle}>{runTitle}</b>
        </div>
        <div className="workflow-tools">
          <button onClick={() => setFollow(!follow)} aria-pressed={follow} title={follow ? "画布跟随正在运行的节点；点选节点后自动停止跟随" : "点击恢复跟随正在运行的节点"}>{follow ? "跟随中" : "跟随"}</button>
          <span className="workflow-zoom">
            <button onClick={() => setZoom(clampZoom(zoom - 0.1))} aria-label="缩小">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(clampZoom(zoom + 0.1))} aria-label="放大">＋</button>
          </span>
          <button onClick={() => setZoom(1)} title="重置缩放">1:1</button>
          <button onClick={() => void reload()} aria-label="刷新" title="刷新">↻</button>
          {onLaunch && summary?.workflowId && <button onClick={() => onLaunch({ workflowId: summary.workflowId, entry: summary.entry || undefined })} title="用同一个工作流再发起一次运行">再次运行</button>}
        </div>
      </div>
      {summary && <div className="workflow-head-row workflow-run-meta">
        <span>{runName}{summary.workflowVersion ? ` ${summary.workflowVersion}` : ""}{summary.entryLabel ? ` · ${summary.entryLabel}` : ""}</span>
        {summary.createdAt != null && <span title={new Date(summary.createdAt).toLocaleString()}>{formatStart(summary.createdAt, now)}开始{elapsed ? ` · ${settled ? "用时" : "已运行"} ${elapsed}` : ""}</span>}
        {summary.requirement && <details className="workflow-run-requirement">
          <summary>需求</summary>
          <p>{summary.requirement}</p>
        </details>}
      </div>}
      {snapshot?.run && <div className="workflow-head-row progress">
        <span className={`workflow-run-word state-${runState}`}>{runWord}</span>
        {stages.length > 0 && <span className="workflow-progress" aria-label={`阶段进度 ${stages.filter((s) => isSettled(s.state)).length}/${stages.length}`}>
          {stages.map((stage) => <i key={stage.id} className={`state-${stage.state}`} title={`${stage.label} · ${STATE_LABEL[stage.state]}`} />)}
          <small>{stages.filter((s) => isSettled(s.state)).length}/{stages.length}</small>
        </span>}
        {currentLabel && (awaiting
          ? <span className="workflow-current attention">等待回复 · <b>{currentLabel}</b></span>
          : <span className="workflow-current">当前 · <b>{currentLabel}</b></span>)}
        <span className="workflow-run-action">
          {snapshot.active && <button onClick={() => void run(() => service.stop(runId))}>停止</button>}
          {!snapshot.active && snapshot.hasLease && <button onClick={() => void run(() => service.recover(runId, "Desktop：确认服务进程退出后解除占用"))}>检查并解除占用</button>}
          {!snapshot.active && !snapshot.hasLease && snapshot.run.status === "stopped" && <button disabled={busy || withoutAuthorization.length > 0} title={withoutAuthorization.length > 0 ? "请先核验未完成动作" : ""} onClick={() => void run(() => service.resume(runId))}>继续运行</button>}
        </span>
      </div>}
    </header>

    {banner && <div className={`workflow-banner tone-${banner.tone}`} role="alert">
      <i aria-hidden="true" />
      <div className="workflow-banner-body">
        <span>{banner.title}</span>
        {(banner.code || banner.detail) && <details>
          <summary>错误码</summary>
          {banner.code && <code>{banner.code}</code>}
          {banner.detail && <div className="workflow-failure-detail">{banner.detail}</div>}
        </details>}
      </div>
      {banner.action === "reconcile" && stuckRecord && <button className="primary" onClick={() => openReconcile(stuckRecord.siteId)}>去处理</button>}
      {banner.action === "open-session" && awaitingSession && onOpenSession && <button className="primary" onClick={() => { if (awaitingRecord) flashNode(awaitingRecord.siteId); onOpenSession(awaitingSession); }}>打开会话</button>}
      {banner.action === "dismiss" && <button onClick={() => setError("")} aria-label="关闭提示">×</button>}
    </div>}

    <div className={`workflow-workspace ${wide ? "is-wide" : "is-stacked"}`}>
    {mismatch ? <div className="workflow-empty">这次运行使用了其他流程版本，当前画布不能可靠映射其节点。</div> : <div
      className="workflow-viewport"
      ref={viewport}
      tabIndex={0}
      aria-label="流程画布"
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        setZoom(clampZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1)));
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "+" || event.key === "=") setZoom(clampZoom(zoom + 0.1));
        else if (event.key === "-") setZoom(clampZoom(zoom - 0.1));
        else if (event.key === "0") setZoom(1);
      }}
    >
      {narrow && <div className="workflow-narrow-hint">
        <span>面板较窄，画布保持最小宽度可横向滚动</span>
        {onWiden && <button onClick={onWiden}>拉宽</button>}
        {onFullView && <button onClick={onFullView}>完整视图</button>}
      </div>}
      {catalog?.structure && catalog.entry
        ? <div className="workflow-stage" style={{ zoom }}>
          <WorkflowHierarchy
            key={runId || catalog.id}
            entry={catalog.entry}
            structure={catalog.structure}
            nodes={catalog.nodes}
            stages={catalog.stages}
            snapshot={snapshot}
            selected={selected}
            selectedPhase={selectedPhase}
            runningSite={follow ? runningId : undefined}
            flashSite={flashSite}
            bandWidth={bandWidth}
            onSelect={select}
          />
        </div>
        : <div className="workflow-empty">{snapshot === null || snapshot.run === null ? "正在读取运行…" : "这次运行的定义里没有可显示的流程结构。"}</div>}
      {currentHidden && runningId && <button className="workflow-jump-current" onClick={() => {
        viewport.current?.querySelector<HTMLElement>("[data-current='true']")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
        setFollow(true);
        flashNode(runningId);
      }}>回到当前节点 · {currentLabel}</button>}
    </div>}

    {node && <aside className="workflow-inspector" aria-label="节点详情">
      <div className="workflow-inspector-head">
        <b title={node.label}>{node.label}</b>
        <code>{record ? `${record.siteId}#${record.ordinal}` : node.id}</code>
        <span className="workflow-inspector-tag"><StatusWord state={state.state} waiting={state.awaiting} /></span>
        {selectedRecords.length > 1 && <span className="workflow-rounds" role="group" aria-label="执行轮次">
          {[...selectedRecords].reverse().map((item) => <button key={item.ordinal} type="button" aria-pressed={item.ordinal === record?.ordinal} aria-label={`第 ${item.ordinal} 轮`} title={`第 ${item.ordinal} 轮 · ${recordStatus(item)}`} onClick={() => setSelectedOrdinal(item.ordinal)} />)}
        </span>}
        {recordSession && onOpenSession && <button className="workflow-inspector-open" aria-label="打开本轮会话" onClick={() => onOpenSession(recordSession)}>打开会话 ↗</button>}
        <button className="workflow-inspector-close" onClick={() => { setSelected(""); clearSelection(); }} aria-label="关闭节点详情">×</button>
      </div>
      {(state.note || record) && <p className="workflow-inspector-note">
        {record && <span>第 {record.ordinal} 轮{selectedRecords.length > 1 ? ` / 共 ${selectedRecords.length} 轮` : ""}</span>}
        {state.note && <span className={state.noteAttention ? "attention" : undefined}>{state.note}</span>}
      </p>}
      <div className="workflow-inspector-body">
        {reconciled?.key === recordKey && <div className="workflow-reconciled"><StatusWord state="done" /><span>已登记核验结论 · {reconciled.mode === "completed" ? "已完成" : "确认未执行，允许重试一次"} · 证据：{reconciled.evidence}</span></div>}
        {page === "reconcile" && reconcilable && reconciled?.key !== recordKey
          ? <div className="workflow-reconcile">
            <h4>核验动作结果</h4>
            <p>请先独立核验该动作的实际执行情况；系统不会自动验证证据。</p>
            <div className="workflow-choice" role="group" aria-label="核验结论">
              <button aria-pressed={recoveryMode === "completed"} onClick={() => setRecoveryMode("completed")}>已完成，登记真实结果</button>
              <button aria-pressed={recoveryMode === "not-executed"} onClick={() => setRecoveryMode("not-executed")}>确认未执行，允许重试一次</button>
            </div>
            {recoveryMode === "completed" && (candidateResult !== null && latestRecord !== undefined && candidateResult.siteId === latestRecord.siteId && candidateResult.ordinal === latestRecord.ordinal
              ? <p>已选择 Agent 提交的候选结果；请核对结果和证据后登记。</p>
              : <label>真实输出（JSON；文本请加双引号）<textarea value={verifiedResult} onChange={(e) => setVerifiedResult(e.target.value)} /></label>)}
            <label>核验证据<input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="例如可核对的报告或记录位置（必填）" /></label>
            <div className="workflow-reconcile-actions">
              <button onClick={() => { setTab("detail"); setCandidateResult(null); }}>取消</button>
              <button className="primary" disabled={busy || evidence.trim() === ""} onClick={() => void reconcile()}>登记核验结论</button>
            </div>
          </div>
          : <NodeDetail
            steps={node.steps}
            conditions={conditions}
            executed={record !== undefined}
            running={record?.status === "running" && !!snapshot?.active}
            live={live}
            view={resultView}
            raw={record?.result}
            sessionMissing={node.kind === "agent" && record !== undefined && recordSession === undefined}
            onOpenFile={onOpenFile}
          >
            {candidates.map((candidate, index) => <details key={candidate.id || index} className="workflow-candidate"><summary>Agent 已提交的候选结果 {index + 1} · 尚未确认执行完成</summary><pre>{typeof candidate.result === "string" ? candidate.result : JSON.stringify(candidate.result, null, 2)}</pre>{!snapshot?.hasLease && latestRecord && <button className="primary" onClick={() => { setCandidateResult({ siteId: latestRecord.siteId, ordinal: latestRecord.ordinal, result: candidate.result }); setRecoveryMode("completed"); setTab("reconcile"); }}>使用此结果进行核验</button>}</details>)}
            {reconcilable && reconciled?.key !== recordKey && <button className="workflow-reconcile-toggle" onClick={() => { setCandidateResult(null); setTab("reconcile"); }}>核验动作结果</button>}
          </NodeDetail>}
      </div>
    </aside>}
    </div>
  </section>;
}

/** 横幅（规约 §7.1）：只有一条，首行人话原因，错误码折叠，最多一个主操作。 */
function bannerOf({ error, snapshot, blockedReason, mismatch, stuckRecord, awaiting }: {
  error: string;
  snapshot: CanvasSnapshot | null;
  blockedReason: string;
  mismatch: boolean;
  stuckRecord: CanvasNodeSnapshot | undefined;
  awaiting: { label: string; sessionId?: string; more: number } | undefined;
}): { tone: "danger" | "warn"; title: string; code?: string; detail?: string; action?: "reconcile" | "dismiss" | "open-session" } | null {
  if (error) return { tone: "danger", title: error, action: "dismiss" };
  const failure = snapshot?.run?.failure;
  if (failure?.code) {
    const detail = failure.detail === undefined || failure.detail === null ? undefined
      : typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail);
    return {
      tone: "warn",
      title: failureLabel(failure.code),
      code: failure.code,
      detail,
      action: stuckRecord && !snapshot?.hasLease ? "reconcile" : undefined,
    };
  }
  // 引擎分不清 Agent 是在提问还是忘了提交，所以只陈述事实：轮次结束、结果未交。
  if (awaiting) {
    return {
      tone: "warn",
      title: `「${awaiting.label}」这一轮结束了、还没有提交结果，等你在会话里回复${awaiting.more > 0 ? `（另有 ${awaiting.more} 个节点也在等）` : ""}`,
      action: awaiting.sessionId ? "open-session" : undefined,
    };
  }
  if (blockedReason) return { tone: "warn", title: blockedReason };
  if (mismatch) return { tone: "warn", title: "这次运行使用了其他流程版本，画布不渲染其节点。" };
  return null;
}

/**
 * 头部进度：每个阶段一段（定义没有阶段时不显示）。与画布条带同一判定：
 * 阶段内全部结束，或运行已走过它（后面的阶段已开始）且其中没有进行中 /
 * 待人处理的节点，才算结束——没被需要的条件节点（修正、整改）不拖住进度。
 */
function progressStages(catalog: WorkflowCatalog | null, snapshot: CanvasSnapshot | null): { id: string; label: string; state: NodeState }[] {
  const stages = catalog?.stages ?? [];
  if (stages.length === 0 || !catalog?.structure) return [];
  const phases = Object.values(catalog.structure.flows).flatMap((flow) => flow.phases);
  const perStage = stages.map((stage) => phases.filter((phase) => phase.stage === stage.id)
    .flatMap((phase) => phase.run.map((site) => nodeStatus({ id: site }, snapshot).state)));
  const touched = perStage.map((states) => states.some((state) => state !== "pending"));
  return stages.map((stage, index) => {
    const states = perStage[index] ?? [];
    const started = states.filter((state) => state !== "pending");
    const urgent = mergeStates(started);
    const passed = touched.slice(index + 1).some(Boolean) || snapshot?.run?.status === "completed";
    let state: NodeState;
    if (started.length === 0) state = "pending";
    else if (!isSettled(urgent)) state = urgent;
    else if (started.length === states.length || passed) state = urgent;
    else state = "running";
    if (state === "running" && !snapshot?.active) state = "pending";
    return { id: stage.id, label: stage.label, state };
  });
}

/** 一轮执行对应的节点会话：经执行者（actor）链接到已收养的会话。 */
function sessionOf(item: CanvasNodeSnapshot, actors: readonly ActorRecord[]): string | undefined {
  return actors.find((actor) => actor.siteId === item.actorSiteId && actor.ordinal === item.actorOrdinal)?.sessionId;
}

