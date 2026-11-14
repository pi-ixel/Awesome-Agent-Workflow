/**
 * 一次运行的视图（AAW 面板第三层；外壳与导航见 WorkflowPanel.tsx）。
 *
 * 结构自上而下：
 * - **头部两行**：标题 + 总结 + 唯一可用的运行动作 + 「⋯」（再次运行、刷新）；
 *   状态词 + 阶段进度 + 当前节点 + 工作流 · 起点 · 用时，需求原文点开再看。
 *   跟随与缩放浮在画布角上；
 * - **一条横幅**：阻塞 / 中断 / 服务错误 / 版本不匹配 / 等你回复 / 等你确认都收进
 *   同一条——首行人话原因，错误码折叠，最多一个主操作（等你确认另有「退回…」）；
 * - **画布**：WorkflowHierarchy（纵向分带）。条带宽度按视口 clamp 到
 *   BAND_MIN…BAND_MAX；低于下限横向滚动并出单行提示（拉宽 / 完整视图）；
 *   离开当前节点时浮出「回到当前节点」；Ctrl+滚轮与 +/-/0 缩放；
 * - **检视器**：面板 ≥ 700px（或完整视图）放画布右侧，否则放画布下方。
 *   头部是状态、轮次圆点和「打开会话」；正文按节点处境给内容（NodeDetail），
 *   原始结果折叠在最后；运行停着时可切到「处置」页（DisposePanel：重跑、
 *   回退、跳过改道、采用已提交的结果，执行前先看预览；ADR 031）。
 *
 * 数据源：每 runId 快照流 `service.snapshot`，动作经 intervene / confirm /
 * reconcile / stop / recover / resume；状态词汇统一由 status/snapshot.ts 给出。
 */
import { RunSummaryPage } from "./RunSummaryPage.tsx";
import { summarizeRun } from "./runSummary.ts";
import { agentErrorMessage, describeError, joinHint, type ErrorText } from "../status/errorText.ts";
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
  gateOf,
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
import { durationPhrase, formatDuration, formatStart, useNow } from "./time.ts";
import { nodeTiming, runWaitedMs } from "../status/timing.ts";
import { kindBadge } from "./nodeText.ts";
import { NodeDetail } from "./NodeDetail.tsx";
import { DisposePanel } from "./DisposePanel.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { MoreMenu } from "./MoreMenu.tsx";
import { disposeActions } from "./dispose.ts";
import { describeResult, entryConditions } from "./nodeDetail.ts";
import "./workflowPanel.css";
import { dangerSize, ghostButton, iconButton, primaryButton, secondaryButton } from "./buttons.ts";
import { Badge, DangerButton } from "../../../shared/ui/controls.tsx";
import { ChevronRightIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { InlineConfirm } from "../../../shared/ui/InlineConfirm.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { Disclosure } from "../../../shared/ui/Disclosure.tsx";

type ActorRecord = CanvasSnapshot["actors"][number];
type InspectorPage = "detail" | "dispose";
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
  const [error, setError] = useState<ErrorText | null>(null);
  const [selectedCallPath, setSelectedCallPath] = useState<string[]>([]);
  const [selectedPhase, setSelectedPhase] = useState<string | undefined>();
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<InspectorPage | undefined>();
  const [confirmStop, setConfirmStop] = useState(false);
  const [follow, setFollow] = useState(true);
  // 运行总结（ADR 035）：和画布二选一显示。
  const [showSummary, setShowSummary] = useState(false);
  const [showRequirement, setShowRequirement] = useState(false);
  const [stream, setStream] = useState<Record<string, string>>({});
  // 节点计划由服务保存；收到计划更新时只需重新读取。
  const [, setPlanVersion] = useState(0);
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
      // 服务退出由外层面板统一显示（带诊断日志末尾），这里不重复。
      if (event.type === "service-exit") return;
      if (event.type === "snapshot-error") {
        setError(typeof event.message === "string" && event.message !== "" ? describeError(event.message) : { title: "运行快照刷新失败。", hint: "可以点「刷新」重试。" });
        return;
      }
      if (event.type === "run-error" && event.runId === runId) {
        setError(typeof event.message === "string" && event.message !== "" ? describeError(event.message) : { title: "运行失败。" });
      }
      if (event.type === "acp-event") {
        const instance = event.instance as { siteId?: unknown; ordinal?: unknown } | undefined;
        const update = event.event as { type?: unknown; text?: unknown } | undefined;
        const siteId = typeof instance?.siteId === "string" ? instance.siteId : null;
        const ordinal = typeof instance?.ordinal === "number" ? instance.ordinal : null;
        if (event.runId !== runId || siteId === null || ordinal === null) return;
        if (update?.type === "user_message_chunk" || update?.type === "workflow_context") {
          const key = `${runId}:${siteId}@${ordinal}`;
          setStream((previous) => ({ ...previous, [key]: "" }));
        }
        if (update?.type === "plan") setPlanVersion((version) => version + 1);
        if (update?.type === "agent_message_chunk" && typeof update.text === "string") {
          const key = `${runId}:${siteId}@${ordinal}`;
          const chunk = update.text;
          setStream((previous) => ({ ...previous, [key]: ((previous[key] ?? "") + chunk).slice(-32000) }));
        }
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service, runId]);

  // 用时随时间走：每 30 秒刷新一次显示。运行停下后，没结束的节点用时停在停下那一刻。
  const now = useNow(30_000);
  const stoppedAt = snapshot?.run && !snapshot.active && snapshot.run.updatedAt != null ? snapshot.run.updatedAt : null;
  const clock = stoppedAt === null ? now : Math.min(now, stoppedAt);

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
  const live = record ? stream[`${runId}:${record.siteId}@${record.ordinal}`] : undefined;
  const candidates = (latestRecord?.status === "running" || latestRecord?.status === "failed") && !snapshot?.active
    ? (latestRecord.candidates ?? []).map((value) => candidateOf(value)).filter((item): item is ResultCandidate => item !== null)
    : [];
  // 停摆后第一个结果未知的动作：横幅的「去处理」直达它的处置页。
  const stuckRecord = snapshot && !snapshot.active ? snapshot.nodes.find((item) => (item.status === "running" || item.status === "failed") && item.mark === undefined) : undefined;
  const uncertain = snapshot?.nodes.filter((item) => (item.status === "running" || item.status === "failed") && item.mark === undefined && (item.kind === "ask" || item.kind === "world-run")) ?? [];
  const withoutAuthorization = uncertain.filter((item) => !snapshot?.retries?.some((retry) => retry.siteId === item.siteId && retry.ordinal === item.ordinal));
  // 检视器头部直达：当前所看轮次的节点会话（Agent 节点）。
  const recordSession = node?.kind === "agent" && record ? sessionOf(record, snapshot?.actors ?? []) : undefined;
  // 本轮的开始时间与用时；等你回复的时间单独说明。作废的记录不显示用时。
  const timing = record && record.mark !== "superseded" ? nodeTiming(record, clock) : null;
  const recordTime = timing
    ? `${formatStart(timing.startedAt, now)}开始 · ${durationPhrase(timing.finished || stoppedAt !== null ? "用时" : "已运行", timing.elapsedMs)}${timing.waitedMs >= 60_000 ? `（其中等你 ${formatDuration(timing.waitedMs)}）` : ""}`
    : "";
  // 处置只在运行停着、没有别的进程占用时可做。
  const disposable = !!record && !snapshot?.hasLease && disposeActions(snapshot, record, candidates.length).length > 0;
  const page: InspectorPage = tab === "dispose" && record ? "dispose" : "detail";
  const described = describeResult(record?.result, node?.labels, snapshot?.artifacts);
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
    setError(null);
    try {
      await cause();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  async function reload(): Promise<void> {
    setError(null);
    try {
      await service.refresh();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function commit(cause: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await cause();
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function select(site: string, path: string[], phase?: string): void {
    if (site !== selected || phase !== selectedPhase) {
      setTab(undefined);
      setSelectedOrdinal(undefined);
    }
    setSelected(site);
    setSelectedCallPath(path);
    setSelectedPhase(phase);
    if (site) setFollow(false);
  }

  /** 打开某条记录的处置页（横幅的「去处理」「退回…」）。 */
  function openDispose(target: CanvasNodeSnapshot): void {
    select(target.siteId, [...target.callPath], target.phaseId ?? undefined);
    setSelectedOrdinal(target.ordinal);
    setTab("dispose");
    flashNode(target.siteId);
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
        : runResult?.status === "blocked" || snapshot.run.status === "waiting" ? "blocked"
          : snapshot.run.status === "completed" ? "done"
            : snapshot.run.status === "failed" ? "failed" : "pending";
  const runWord = !snapshot?.run ? "" : interrupted ? "已中断" : statusLabel(snapshot.run, catalog);
  const stages = progressStages(catalog, snapshot);
  // 一轮结束仍无结果、引擎在等用户经会话回复的节点（引擎记录的标记）。
  const awaitingRecords = snapshot?.active ? snapshot.nodes.filter((item) => item.status === "running" && item.awaitingInput === true) : [];
  const awaitingRecord = awaitingRecords[0];
  const awaiting = awaitingRecord && {
    label: byId.get(awaitingRecord.siteId)?.label ?? awaitingRecord.siteId,
    sessionId: sessionOf(awaitingRecord, snapshot?.actors ?? []),
    more: awaitingRecords.length - 1,
  };
  const waitingItems = awaitingRecords.map((item) => {
    const label = byId.get(item.siteId)?.label ?? item.siteId;
    const peers = awaitingRecords.filter((other) => (byId.get(other.siteId)?.label ?? other.siteId) === label);
    const position = peers.indexOf(item) + 1;
    const text = stream[`${runId}:${item.siteId}@${item.ordinal}`]?.trim();
    return {
      record: item,
      label: peers.length > 1 ? `${label}（第 ${position} 个实例）` : label,
      sessionId: sessionOf(item, snapshot?.actors ?? []),
      excerpt: text ? (text.length > 180 ? `…${text.slice(-180)}` : text) : undefined,
    };
  });
  const currentLabel = (() => {
    const focus = awaitingRecord ?? runningRecord ?? stuckRecord;
    return focus ? byId.get(focus.siteId)?.label ?? focus.siteId : "";
  })();
  // 等你确认：关卡所在步骤里最近完成的那条记录（退回时从它的步骤重做）。
  const gates = snapshot && !snapshot.active ? snapshot.gates ?? [] : [];
  const gate = gates[0];
  const gateRecord = gate ? snapshot?.nodes.filter((item) => item.mark === undefined && gateOf(item, [gate])).sort((a, b) => b.ordinal - a.ordinal)[0] : undefined;
  const gating = gate && {
    step: gateRecord ? byId.get(gateRecord.siteId)?.label ?? gateRecord.siteId : gate.phase,
    route: gate.label,
    more: gates.length - 1,
  };
  const banner = bannerOf({ error, snapshot, blockedReason, mismatch, stuckRecord, awaiting, gating });
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
  // 其中等你回复的时间；不足 1 分钟不提。
  const waitedTotal = snapshot ? runWaitedMs(snapshot.nodes, clock) : 0;
  const summaryView = showSummary && snapshot ? summarizeRun(snapshot, now) : null;
  const waitedText = waitedTotal >= 60_000 ? `（其中等你 ${formatDuration(waitedTotal)}）` : "";

  return <section className="workflow-run" aria-label="流程运行" ref={panelRef}>
    <header className="workflow-head">
      <div className="workflow-head-row workflow-run-titlebar">
        <b className="workflow-run-name" data-hint={runTitle}>{runTitle}</b>
        <span className="workflow-run-action">
          {snapshot?.run && <button type="button" className={secondaryButton} onClick={() => setShowSummary(!showSummary)} aria-pressed={showSummary} data-hint="这次运行的概况、各节点做了什么和产出文件">{showSummary ? "返回流程图" : "总结"}</button>}
          {snapshot?.active && <DangerButton className={dangerSize} onClick={() => setConfirmStop(true)} disabled={confirmStop}>停止</DangerButton>}
          {snapshot?.run && !snapshot.active && snapshot.hasLease && <button type="button" className={primaryButton} onClick={() => void run(() => service.recover(runId, "Desktop：确认服务进程退出后解除占用"))}>检查并解除占用</button>}
          {snapshot?.run && !snapshot.active && !snapshot.hasLease && snapshot.run.status === "stopped" && withoutAuthorization.length === 0 && <button type="button" className={primaryButton} disabled={busy} onClick={() => void run(() => service.resume(runId))}>继续运行</button>}
          <MoreMenu entries={[
            ...(onLaunch && summary?.workflowId ? [{ id: "again", label: "再次运行", onSelect: () => onLaunch({ workflowId: summary.workflowId, entry: summary.entry || undefined }) }] : []),
            { id: "refresh", label: "刷新", onSelect: () => void reload() },
          ]} />
        </span>
      </div>
      {snapshot?.active && confirmStop && <InlineConfirm className="workflow-stop-confirm" label="确认停止" message="正在执行的节点会被中断，之后可以继续运行或处置。确定停止？" confirmLabel="停止" onConfirm={() => { setConfirmStop(false); void run(() => service.stop(runId)); }} onCancel={() => setConfirmStop(false)} />}
      <div className="workflow-head-row workflow-run-meta">
        {snapshot?.run && <StatusWord state={runState} waiting={awaiting !== undefined} label={runWord} />}
        {stages.length > 0 && <span className="workflow-progress" aria-label={`阶段进度 ${stages.filter((s) => isSettled(s.state)).length}/${stages.length}`}>
          {stages.map((stage) => <i key={stage.id} className={`state-${stage.state}`} data-hint={`${stage.label} · ${STATE_LABEL[stage.state]}`} />)}
          <small>{stages.filter((s) => isSettled(s.state)).length}/{stages.length}</small>
        </span>}
        {currentLabel && (awaiting
          ? <span className="workflow-current attention">等待回复 · <b>{currentLabel}</b></span>
          : <span className="workflow-current">{snapshot?.active ? "当前" : "停在"} · <b>{currentLabel}</b></span>)}
        {summary && <span className="workflow-run-info" data-hint={summary.createdAt != null ? `${formatStart(summary.createdAt, now)}开始` : undefined}>
          {runName}{summary.entryLabel ? ` · ${summary.entryLabel}` : ""}{elapsed ? ` · ${settled ? "用时" : "已运行"} ${elapsed}${waitedText}` : ""}
        </span>}
        {summary?.requirement && <TextLink className="shrink-0" aria-expanded={showRequirement} onClick={() => setShowRequirement(!showRequirement)}>需求</TextLink>}
      </div>
      {showRequirement && summary?.requirement && <p className="workflow-run-requirement">{summary.requirement}</p>}
    </header>

    {error && snapshot?.run?.failure?.code && error.code !== snapshot.run.failure.code && <Callout tone="danger" className="workflow-callout" title={joinHint(error)} onDismiss={() => setError(null)} />}
    {banner && <Callout
      tone={banner.tone}
      className="workflow-callout"
      title={banner.title}
      details={banner.code || banner.detail ? [banner.code, banner.detail].filter(Boolean).join("\n") : undefined}
      onDismiss={banner.action === "dismiss" ? () => setError(null) : undefined}
      actions={banner.action === "dispose" && stuckRecord && !(page === "dispose" && record === stuckRecord)
        ? <button type="button" className={primaryButton} onClick={() => openDispose(stuckRecord)}>去处理</button>
        : banner.action === "confirm" && gate ? <>
          {gateRecord && <button type="button" className={secondaryButton} onClick={() => openDispose(gateRecord)}>退回…</button>}
          <button type="button" className={primaryButton} disabled={busy} onClick={() => void commit(() => service.confirm(runId, gate.instance))}>继续</button>
        </> : undefined}
    >
      {banner.hint}
      {banner.action === "open-session" && <div className="workflow-waiting-list" aria-label="等待回复的节点">
        {waitingItems.map((item) => <div className="workflow-waiting-item" key={`${item.record.siteId}@${item.record.ordinal}`}>
          <div><strong>{item.label}</strong><p>{item.excerpt ?? "请打开会话查看 Agent 的消息；也可能是节点尚未提交结果。"}</p></div>
          {item.sessionId && onOpenSession && <button type="button" className={secondaryButton} onClick={() => { select(item.record.siteId, [...item.record.callPath], item.record.phaseId ?? undefined); setSelectedOrdinal(item.record.ordinal); onOpenSession(item.sessionId!); }}>打开会话</button>}
        </div>)}
      </div>}
    </Callout>}

    {showSummary && summaryView ? <div className="workflow-workspace workflow-summary-wrap">
      <RunSummaryPage
        summary={summaryView}
        now={now}
        onOpenFile={onOpenFile}
        onSelectStep={(step) => {
          setShowSummary(false);
          select(step.siteId, [...step.callPath], step.phaseId ?? undefined);
          setSelectedOrdinal(step.ordinal);
        }}
      />
    </div> : <div className={`workflow-workspace ${wide ? "is-wide" : "is-stacked"}`}>
    {mismatch ? <div className="workflow-empty">这次运行使用了其他流程版本，当前画布不能可靠映射其节点。</div> : <GraphCanvas
      zoom={zoom}
      onZoom={setZoom}
      label="流程画布"
      viewportRef={viewport}
      onMinimapJump={() => setFollow(false)}
      tools={snapshot?.active && <button type="button" onClick={() => setFollow(!follow)} aria-pressed={follow} data-hint={follow ? "画布跟随正在运行的节点；点选节点后自动停止跟随" : "点击恢复跟随正在运行的节点"}>{follow ? "跟随中" : "跟随"}</button>}
      before={narrow && <div className="workflow-narrow-hint">
        <span>面板较窄，画布保持最小宽度可横向滚动</span>
        {onWiden && <button type="button" className={secondaryButton} onClick={onWiden}>拉宽</button>}
        {onFullView && <button type="button" className={secondaryButton} onClick={onFullView}>完整视图</button>}
      </div>}
      empty={catalog?.structure && catalog.entry ? undefined : <div className="workflow-empty">{snapshot === null || snapshot.run === null ? "正在读取运行…" : "这次运行的定义里没有可显示的流程结构。"}</div>}
      after={currentHidden && runningId && <button className="workflow-jump-current" onClick={() => {
        viewport.current?.querySelector<HTMLElement>("[data-current='true']")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
        setFollow(true);
        flashNode(runningId);
      }}>回到当前节点 · {currentLabel}</button>}
    >
      {catalog?.structure && catalog.entry && <WorkflowHierarchy
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
        now={clock}
        planOf={(item) => service.nodePlan(runId, item.siteId, item.ordinal)}
        onSelect={select}
      />}
    </GraphCanvas>}

    {node && <aside className="workflow-inspector" aria-label="节点详情">
      {!wide && <button type="button" className={`${ghostButton} workflow-inspector-back`} onClick={() => { setSelected(""); clearSelection(); }}><ChevronRightIcon className="size-3.5 rotate-180" />返回流程图</button>}
      <div className="workflow-inspector-head">
        <b data-hint={node.label}>{node.label}</b>
        {node.kind !== "agent" && <Badge>{kindBadge(node.kind)}</Badge>}
        <StatusWord state={state.state} waiting={state.awaiting} />
        {selectedRecords.length > 1 && <span className="workflow-rounds" role="group" aria-label="执行轮次">
          {[...selectedRecords].reverse().map((item) => <button key={item.ordinal} type="button" aria-pressed={item.ordinal === record?.ordinal} aria-label={`第 ${item.ordinal} 轮`} data-hint={`第 ${item.ordinal} 轮 · ${recordStatus(item)}`} onClick={() => setSelectedOrdinal(item.ordinal)} />)}
        </span>}
        {recordSession && onOpenSession && <button type="button" className={`${secondaryButton} workflow-inspector-open`} aria-label="打开本轮会话" onClick={() => onOpenSession(recordSession)}>打开会话</button>}
        <button type="button" className={`${iconButton} workflow-inspector-close`} onClick={() => { setSelected(""); clearSelection(); }} aria-label="关闭节点详情"><XIcon className="size-3.5" /></button>
      </div>
      {(state.note || record) && <p className="workflow-inspector-note">
        {record && <span>第 {record.ordinal} 轮{selectedRecords.length > 1 ? ` / 共 ${selectedRecords.length} 轮` : ""}</span>}
        {recordTime && <span>{recordTime}</span>}
        {state.note && <span className={state.noteAttention ? "attention" : undefined}>{state.note}</span>}
      </p>}
      <div className="workflow-inspector-body">
        {page === "dispose" && record
          ? <DisposePanel
            key={`${record.siteId}#${record.ordinal}`}
            service={service}
            runId={runId}
            snapshot={snapshot}
            catalog={catalog}
            record={record}
            candidates={record.ordinal === latestRecord?.ordinal ? candidates : []}
            onDone={(message) => { setTab("detail"); if (message) setError(describeError(message)); }}
            onCancel={() => setTab("detail")}
          />
          : <NodeDetail
            steps={node.steps}
            conditions={conditions}
            executed={record !== undefined}
            running={record?.status === "running" && !!snapshot?.active}
            live={live}
            plan={record ? service.nodePlan(runId, record.siteId, record.ordinal) : null}
            view={resultView}
            raw={record?.result}
            sessionMissing={node.kind === "agent" && record !== undefined && recordSession === undefined}
            onOpenFile={onOpenFile}
          >
            {record?.ordinal === latestRecord?.ordinal && candidates.map((candidate, index) => <Disclosure key={candidate.id || index} className="workflow-candidate" summary={`Agent 已提交的结果 ${index + 1} · 流程尚未接受`}><pre>{typeof candidate.result === "string" ? candidate.result : JSON.stringify(candidate.result, null, 2)}</pre></Disclosure>)}
            {record?.mark === "superseded" && <p className="workflow-inspector-note">这一轮已被回退作废，只供回看。</p>}
            {disposable && (snapshot?.active
              ? <button type="button" className={secondaryButton} disabled data-hint="运行正在执行；先在上方停止运行">处置…</button>
              : <button type="button" className={secondaryButton} onClick={() => setTab("dispose")}>处置…</button>)}
          </NodeDetail>}
      </div>
    </aside>}
    </div>}
  </section>;
}

/** 横幅（规约 §7.1）：只有一条，首行人话原因，错误码折叠，最多一个主操作。 */
function bannerOf({ error, snapshot, blockedReason, mismatch, stuckRecord, awaiting, gating }: {
  error: ErrorText | null;
  snapshot: CanvasSnapshot | null;
  blockedReason: string;
  mismatch: boolean;
  stuckRecord: CanvasNodeSnapshot | undefined;
  awaiting: { label: string; sessionId?: string; more: number } | undefined;
  gating: { step: string; route: string | null; more: number } | undefined;
}): { tone: "danger" | "warn"; title: string; hint?: string; code?: string; detail?: string; action?: "dispose" | "dismiss" | "open-session" | "confirm" } | null {
  const failure = snapshot?.run?.failure;
  // 运行本身的失败原因优先；面板操作的报错另起一行，不盖住它。
  if (error && !failure?.code) return { tone: "danger", ...error, action: stuckRecord && !snapshot?.hasLease ? "dispose" : "dismiss" };
  if (failure?.code) {
    const detail = failure.detail === undefined || failure.detail === null ? undefined
      : typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail);
    // 细节里带着更具体的错误码时按它说明（例如节点会话恢复失败的原因）。
    const specific = detail ? describeError(detail) : null;
    const agent = detail ? agentErrorMessage(detail) : null;
    const text = agent
      ? { title: `Agent 报错：${agent}`, hint: stuckRecord ? "Agent 恢复后，点「去处理」重跑这一步。" : "Agent 恢复后，在节点上点「处置…」重跑这一步。" }
      : specific?.code && specific.code !== failure.code ? specific : describeError(failure.code);
    return {
      tone: "warn",
      title: text.title,
      ...(text.hint ? { hint: text.hint } : {}),
      code: failure.code,
      detail,
      action: stuckRecord && !snapshot?.hasLease ? "dispose" : undefined,
    };
  }
  // 引擎分不清 Agent 是在提问还是忘了提交，所以只陈述事实：轮次结束、结果未交。
  if (awaiting) {
    return {
      tone: "warn",
      title: awaiting.more > 0 ? `${awaiting.more + 1} 个节点这一轮结束后尚未提交结果，请查看会话。` : `「${awaiting.label}」这一轮结束了，还没有提交结果，请查看会话。`,
      action: "open-session",
    };
  }
  if (gating) {
    return {
      tone: "warn",
      title: `「${gating.step}」已完成，${gating.route ? `「${gating.route}」` : "继续往下"}之前需要你确认${gating.more > 0 ? `（另有 ${gating.more} 处也在等确认）` : ""}`,
      action: "confirm",
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

