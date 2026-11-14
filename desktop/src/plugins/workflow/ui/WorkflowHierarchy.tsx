/**
 * 执行关系画布：纵向阶段分带 + 单列主干 + 并行双子卡（UI 原型规约 §6）。
 *
 * 只画执行协议供给的 phase、call 与 route（不发明工作）：
 * - 阶段来自流程定义的 `stages` / `phase.stage`（ADR 025 §2）；定义没有阶段
 *   时整层是一个不带标题的条带，phase 未标注阶段时归入「其他」；
 * - 行序来自 route 的拓扑秩（环先折叠，汇合点排在最长的入边分支之后）；
 *   同秩的 phase、以及一个 phase 内并行的动作，并排成双子卡；
 * - 条带宽度由面板按视口给出（BAND_MIN…BAND_MAX），低于下限时由面板横向
 *   滚动，画布本身不压缩卡片；
 * - 整带已结束时收成一行摘要；当前节点所在带、选中节点所在带始终展开；
 * - 连线只标定义作者写的标签（「有发现」「复核」），不再给每条条件边贴
 *   「条件 / 其他情况」；条件边用虚线表达。回到上游的边走右侧导轨。
 *
 * 子流程：call phase 是一张带「进入子流程 ›」的卡片，进入后面包屑与执行
 * 实例选择照旧（逐层画布，阶段顺序在每一层复用）。
 *
 * 键盘：方向键在卡片之间按画布位置移动焦点（不改选中，不打断跟随），
 * Enter 打开节点或进入子流程，Esc 回到上一层。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  HierarchyFlowDefinition,
  HierarchyFlowPhase,
  HierarchyFlowRoute,
  HierarchyStructure,
  WorkflowCatalogNode,
  WorkflowStage,
} from "../types.ts";
import {
  isSettled,
  mergeStates,
  nodeStatus,
  STATE_LABEL,
  type NodeState,
  type NodeStatusView,
} from "../status/snapshot.ts";
import { cardTime, kindBadge } from "./nodeText.ts";
import { planProgress, type NodePlanEntry } from "../status/nodePlans.ts";
import { Listbox } from "../../../shared/ui/controls.tsx";

/** 条带宽度上下限（规约 §6.2）：低于下限宁可横向滚动，高于上限不再拉长。 */
export const BAND_MIN = 380;
export const BAND_MAX = 430;
/** 画布左右内边距与右侧回环导轨宽度（条带可用宽 = 视口 − 内边距×2 − 导轨）。 */
export const CANVAS_PAD = 20;
export const LOOP_GUTTER = 40;
/** 回环导轨上相邻两道的间距。 */
const RAIL_LANE = 6;

const BAND_PAD = 10;
const BAND_HEAD = 36;
const BAND_GAP = 26;
const ROW_GAP = 26;
const TWIN_GAP = 8;
const SUMMARY_H = 40;
const CARD_H = 62;
const CARD_NOTE_H = 22;
const CALL_H = 92;
const CONNECTOR_H = 24;
const TERMINAL_H = 30;

type Frame = { flow: string; entry: string; via?: string; instanceId?: string };
type Rect = { x: number; y: number; w: number; h: number };
/** 画布上的一块落点：矩形 + 全局行序（跨条带连续编号，决定连线走直通还是导轨）。 */
type Slot = { rect: Rect; row: number };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

export function WorkflowHierarchy({
  entry,
  structure,
  nodes,
  stages = [],
  snapshot,
  selected,
  selectedPhase,
  focusOrdinal,
  runningSite,
  flashSite,
  bandWidth = BAND_MAX,
  now,
  planOf,
  onSelect,
}: {
  entry: string;
  structure: HierarchyStructure;
  nodes: readonly WorkflowCatalogNode[];
  stages?: readonly WorkflowStage[];
  snapshot: CanvasSnapshot | null;
  selected: string;
  selectedPhase?: string;
  focusOrdinal?: number;
  runningSite?: string;
  /** 跳转定位到的节点：卡片外圈闪一下再淡掉（面板在跳转时设置、随后清除）。 */
  flashSite?: string;
  /** 条带宽度（面板按视口算好的 clamp(BAND_MIN, 可用宽, BAND_MAX)）。 */
  bandWidth?: number;
  /** 当前时刻（面板按间隔刷新），用于已运行和等待时长；不给时卡片不显示时间。 */
  now?: number;
  /** 节点这一轮 Agent 发来的计划（ACP plan）；有计划时卡片显示进度。 */
  planOf?: (record: CanvasNodeSnapshot) => readonly NodePlanEntry[] | null;
  onSelect: (site: string, callPath: string[], phaseId?: string) => void;
}) {
  const root: Frame = { flow: structure.rootFlow, entry };
  const [path, setPath] = useState<Frame[]>([root]);
  const [expandedBands, setExpandedBands] = useState<ReadonlySet<string>>(() => new Set());
  // 键盘进出子流程后把焦点放回画布上（进入：当前或第一张卡；返回：刚才那张子流程卡）。
  const graph = useRef<HTMLDivElement | null>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    if (want === null || !graph.current) return;
    const cards = [...graph.current.querySelectorAll<HTMLElement>("[data-nav-x]")];
    const card = (want ? cards.find((c) => c.dataset.navCall === want) : undefined)
      ?? cards.find((c) => c.closest("[data-current='true']"))
      ?? cards[0];
    card?.focus();
  }, [path]);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const target = focusOrdinal !== undefined ? selected : runningSite;
  const targetRecord = snapshot?.nodes.filter((n) => n.siteId === target && (focusOrdinal === undefined || n.ordinal === focusOrdinal)).sort((a, b) => b.ordinal - a.ordinal)[0];
  const targetPathKey = `${targetRecord?.phaseId ?? ""}:${targetRecord?.ordinal ?? ""}:${targetRecord?.callPath?.join("|") ?? ""}`;
  const navigationKey = target ? `${structure.rootFlow}:${entry}:${target}:${focusOrdinal ?? ""}:${targetPathKey}` : "";
  const [lastNavigation, setLastNavigation] = useState("");
  if (navigationKey !== lastNavigation) {
    setLastNavigation(navigationKey);
    if (target) {
      const find = (frame: Frame, seen: Set<string>): Frame[] | null => {
        const key = `${frame.flow}:${frame.entry}`;
        if (seen.has(key)) return null;
        const flow = structure.flows[frame.flow];
        if (!flow) return null;
        const next = new Set(seen);
        next.add(key);
        const expanded = expandDependencies(flow, frame.entry, nodeMap);
        for (const phase of reachable(expanded.flow, expanded.entry)) {
          if (phase.run.includes(target) && (!targetRecord?.phaseId || targetRecord.phaseId === (phase.sourcePhaseId ?? phase.id))) return [frame];
          if (phase.call) {
            const child = structure.flows[phase.call];
            if (child) {
              const matches = (snapshot?.execution?.calls ?? []).filter((c) => c.phase === phase.id && c.parent === (frame.instanceId ?? null));
              const instance = matches.find((c) => targetRecord?.callPath?.includes(c.id)) ?? matches.find((c) => c.status === "running") ?? matches[matches.length - 1];
              const result = find({ flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: instance?.id }, next);
              if (result) return [frame, ...result];
            }
          }
        }
        return null;
      };
      const result = find({ flow: structure.rootFlow, entry }, new Set());
      if (result) setPath(result);
    }
  }
  const current = path[path.length - 1] ?? root;
  const flow = structure.flows[current.flow];
  const expanded = useMemo(() => flow ? expandDependencies(flow, current.entry, nodeMap) : null, [flow, current.entry, nodeMap]);
  if (!flow || !expanded) return <div className="workflow-empty">流程定义缺少当前子流程。</div>;

  const runResult = snapshot?.run ? asRecord(snapshot.run.result) : null;
  const activePhases = new Set([snapshot?.execution?.phase, ...(snapshot?.execution?.stack ?? []).map((f) => f.phase)]);
  const isActiveInCurrent = !current.via || !!current.instanceId && !!snapshot?.execution?.calls.some((call) => call.id === current.instanceId && call.status === "running");
  const inCurrent = (record: CanvasNodeSnapshot) => !current.via || !!current.instanceId && !!record.callPath?.includes(current.instanceId);
  const instances = (phase: string, parent?: string) => (snapshot?.execution?.calls ?? []).filter((c) => c.phase === phase && c.parent === (parent ?? null));
  const latestRecord = (site: string, phaseId: string) =>
    snapshot?.nodes.filter((n) => n.siteId === site && n.phaseId === phaseId && inCurrent(n)).sort((a, b) => b.ordinal - a.ordinal)[0];
  const siteState = (site: string, phaseId: string): NodeStatusView => {
    const record = latestRecord(site, phaseId);
    if (!snapshot || !record) return nodeStatus({ id: site }, null);
    return nodeStatus({ id: site }, { ...snapshot, nodes: [record] });
  };
  const callCounts = (phase: HierarchyFlowPhase) => {
    const calls = current.via && !current.instanceId ? [] : instances(phase.id, current.instanceId);
    return { calls, done: calls.filter((c) => c.status === "completed").length };
  };
  // 一次子流程执行里有没有需要人看的事：等回复优先，其次是失败。
  const callAttention = (call: CanvasExecutionCall): "等待回复" | "失败" | null => {
    if (snapshot?.active && snapshot.nodes.some((n) => n.status === "running" && n.awaitingInput === true && n.callPath?.includes(call.id))) return "等待回复";
    return call.status === "failed" ? "失败" : null;
  };
  const instanceWord = (call: CanvasExecutionCall): string =>
    callAttention(call) ?? (call.status === "completed" ? "已完成" : call.status === "running" ? (snapshot?.active ? "运行中" : "已停止") : call.status === "skipped" ? "未触发" : "未开始");
  const phaseState = (phase: HierarchyFlowPhase): NodeState => {
    if (!snapshot) return "pending";
    if (phase.call) {
      const { calls } = callCounts(phase);
      if (phase.sourceNodeId) {
        const lastCall = calls.reduce<CanvasExecutionCall | undefined>((latest, call) => !latest || call.ordinal > latest.ordinal ? call : latest, undefined);
        const record = latestRecord(phase.sourceNodeId, phase.sourcePhaseId ?? phase.id);
        if (record?.status === "skipped" && (!lastCall || record.ordinal > lastCall.ordinal)) return "skipped";
        if (!lastCall) return "pending";
        if (lastCall.status === "failed") return "failed";
        if (lastCall.status === "running") return snapshot.active ? "running" : "stuck";
        return lastCall.status === "completed" ? "done" : "pending";
      }
      if (!calls.length) return "pending";
      if (calls.some((c) => c.status === "failed")) return "failed";
      if (calls.some((c) => c.status === "running")) return snapshot.active ? "running" : runResult?.status === "blocked" ? "blocked" : "stuck";
      return calls.every((c) => c.status === "completed") ? "done" : "pending";
    }
    if (isActiveInCurrent && runResult?.status === "blocked" && runResult?.stage === phase.id) return "blocked";
    const states = phase.run.map((site) => siteState(site, phase.sourcePhaseId ?? phase.id).state);
    const merged = mergeStates(states);
    // 执行位置就在这一步、服务仍在跑：即使记录尚未落账也是「运行中」。
    if (snapshot.active && isActiveInCurrent && activePhases.has(phase.id) && !isSettled(merged)) return "running";
    return merged;
  };

  // ------------------------------------------------------------ 布局模型
  const phases = reachable(expanded.flow, expanded.entry);
  const ranks = computeRanks(phases);
  const sourceStage = new Map(flow.phases.map((p) => [p.id, p.stage ?? null]));
  const stageOf = (phase: HierarchyFlowPhase): string | null => {
    if (phase.connector) {
      const first = phase.routes[0]?.next;
      const next = phases.find((p) => p.id === first);
      return next ? stageOf(next) : null;
    }
    return phase.stage ?? (phase.sourcePhaseId ? sourceStage.get(phase.sourcePhaseId) ?? null : null);
  };
  const declared = new Set(stages.map((s) => s.id));
  const bands: { id: string; label: string; tag: string; phases: HierarchyFlowPhase[] }[] = stages.length === 0
    ? [{ id: "", label: "", tag: "", phases }]
    : [
      ...stages.map((stage) => ({ id: stage.id, label: stage.label, tag: "", phases: phases.filter((p) => stageOf(p) === stage.id) })),
      { id: "$other", label: "其他", tag: "", phases: phases.filter((p) => { const s = stageOf(p); return s === null || !declared.has(s); }) },
    ].filter((band) => band.phases.length > 0).map((band, index) => ({ ...band, tag: String(index + 1).padStart(2, "0") }));

  const states = new Map(phases.map((p) => [p.id, phaseState(p)]));
  // 这一步里有节点在等用户回复：不算「正在跑」，连线不流动。
  const waitingPhases = new Set(phases.filter((p) => p.run.some((site) => siteState(site, p.sourcePhaseId ?? p.id).awaiting)).map((p) => p.id));
  const focusedPhase = selectedPhase ?? (focusOrdinal !== undefined ? targetRecord?.phaseId ?? undefined : undefined);
  const isCurrentPhase = (phase: HierarchyFlowPhase) => {
    const state = states.get(phase.id);
    return state === "running" || state === "stuck" || state === "blocked" || (isActiveInCurrent && activePhases.has(phase.id) && !!snapshot?.active);
  };
  const isSelectedPhase = (phase: HierarchyFlowPhase) =>
    phase.run.includes(selected) && (!focusedPhase || focusedPhase === (phase.sourcePhaseId ?? phase.id));

  type Item = { phase: HierarchyFlowPhase; rect: Rect; row: number; current: boolean };
  type BandBox = { id: string; label: string; tag: string; rect: Rect; collapsed: boolean; active: boolean; settled: number; total: number };
  const items: Item[] = [];
  const bandBoxes: BandBox[] = [];
  const collapsedAnchor = new Map<string, Slot>();
  let rowCursor = 0;
  const left = CANVAS_PAD;
  const inner = bandWidth - BAND_PAD * 2;
  let y = 12;
  // 「运行已走过这一带」：后面某一带已经有节点开始。条件节点（修正、整改）
  // 没被需要时永远是未触发，只看「全部结束」的话这样的带永远收不起来。
  const touched = bands.map((band) => band.phases.some((p) => (states.get(p.id) ?? "pending") !== "pending"));
  const passed = bands.map((_, index) => touched.slice(index + 1).some(Boolean));
  for (const [bandIndex, band] of bands.entries()) {
    const settledCount = band.phases.filter((p) => isSettled(states.get(p.id) ?? "pending")).length;
    const active = band.phases.some(isCurrentPhase) || band.phases.some(isSelectedPhase);
    const urgent = band.phases.some((p) => { const state = states.get(p.id); return state === "failed" || state === "blocked" || state === "stuck" || state === "running"; });
    const finished = band.phases.length > 0 && !urgent && (settledCount === band.phases.length || (settledCount > 0 && passed[bandIndex] === true));
    const collapsed = finished && !active && !expandedBands.has(band.id) && band.id !== "";
    if (collapsed) {
      const rect = { x: left, y, w: bandWidth, h: SUMMARY_H };
      bandBoxes.push({ id: band.id, label: band.label, tag: band.tag, rect, collapsed, active, settled: settledCount, total: band.phases.length });
      const slot = { rect, row: rowCursor++ };
      for (const phase of band.phases) collapsedAnchor.set(phase.id, slot);
      y += SUMMARY_H + BAND_GAP;
      continue;
    }
    const top = y;
    y += band.label ? BAND_HEAD : BAND_PAD;
    const rows = new Map<number, HierarchyFlowPhase[]>();
    for (const phase of band.phases) {
      const rank = ranks.get(phase.id) ?? 0;
      rows.set(rank, [...(rows.get(rank) ?? []), phase]);
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    ordered.forEach(([, row], index) => {
      const height = Math.max(...row.map((phase) => phaseHeight(phase, phase.run.map((site) => siteState(site, phase.sourcePhaseId ?? phase.id)))));
      const width = (inner - TWIN_GAP * (row.length - 1)) / row.length;
      row.forEach((phase, column) => {
        const h = phase.connector ? CONNECTOR_H : height;
        const w = phase.connector ? Math.min(120, width) : width;
        const x = left + BAND_PAD + column * (width + TWIN_GAP) + (phase.connector ? (width - w) / 2 : 0);
        items.push({ phase, rect: { x, y: y + (height - h) / 2, w, h }, row: rowCursor, current: isCurrentPhase(phase) });
      });
      rowCursor += 1;
      y += height + (index < ordered.length - 1 ? ROW_GAP : 0);
    });
    y += BAND_PAD;
    bandBoxes.push({ id: band.id, label: band.label, tag: band.tag, rect: { x: left, y: top, w: bandWidth, h: y - top }, collapsed: false, active, settled: settledCount, total: band.phases.length });
    y += BAND_GAP;
  }
  const terminals = [...new Set(phases.flatMap((p) => p.routes.map((r) => r.next).filter((n) => n.startsWith("$"))))];
  const terminalRects = new Map<string, Rect>();
  const terminalRow = rowCursor;
  if (terminals.length > 0) {
    const width = Math.min(120, (bandWidth - TWIN_GAP * (terminals.length - 1)) / terminals.length);
    const total = width * terminals.length + TWIN_GAP * (terminals.length - 1);
    terminals.forEach((id, index) => terminalRects.set(id, { x: left + (bandWidth - total) / 2 + index * (width + TWIN_GAP), y, w: width, h: TERMINAL_H }));
    y += TERMINAL_H;
  }
  const canvasHeight = y + 16;
  const slotOf = new Map(items.map((item) => [item.phase.id, { rect: item.rect, row: item.row }]));
  const anchor = (id: string): Slot | undefined => {
    const terminal = terminalRects.get(id);
    return slotOf.get(id) ?? collapsedAnchor.get(id) ?? (terminal ? { rect: terminal, row: terminalRow } : undefined);
  };

  // ------------------------------------------------------------ 连线
  // 只有相邻两行之间的边直通（行间空隙里画）；跨行前进与回到上游的边都走
  // 右侧导轨，保证连线永远不穿过中间的卡片（规约 §6.2）。
  const railX = left + bandWidth + 10;
  let lanes = 0;
  const drawn = new Set<string>();
  const edges = phases.flatMap((phase) => phase.routes.flatMap((route) => {
    const from = anchor(phase.id);
    const to = anchor(route.next);
    if (!from || !to || from.rect === to.rect) return [];
    const a = from.rect;
    const b = to.rect;
    const key = `${a.x},${a.y}>${b.x},${b.y}`;
    if (drawn.has(key) && (collapsedAnchor.has(phase.id) || collapsedAnchor.has(route.next))) return [];
    drawn.add(key);
    const fromState = states.get(phase.id) ?? "pending";
    const toState = route.next.startsWith("$") ? "pending" : states.get(route.next) ?? "pending";
    const label = route.label ?? "";
    const tone = isSettled(fromState) && isSettled(toState) ? "settled" : isSettled(fromState) && (toState === "running" || toState === "stuck" || toState === "blocked") ? "flowing" : "";
    // 流动只给「真在跑」的去向：卡住 / 阻塞 / 等用户回复时线静止。
    const live = tone === "flowing" && toState === "running" && snapshot?.active === true && !waitingPhases.has(route.next);
    const common = { from: phase.id, to: route.next, conditional: route.conditional, tone: live ? `${tone} live` : tone, label };
    if (to.row === from.row + 1) {
      const sx = a.x + a.w / 2;
      const sy = a.y + a.h;
      const ex = b.x + b.w / 2;
      const ey = b.y;
      const mid = (sy + ey) / 2;
      return [{
        ...common,
        path: Math.abs(sx - ex) < 1 ? `M ${sx} ${sy} L ${ex} ${ey}` : `M ${sx} ${sy} C ${sx} ${mid}, ${ex} ${mid}, ${ex} ${ey}`,
        arrow: `M ${ex - 4} ${ey - 6} L ${ex} ${ey} L ${ex + 4} ${ey - 6}`,
        textX: (sx + ex) / 2 + 8, textY: mid + 3, anchor: "start" as const,
      }];
    }
    // 去往终点（流程完成 / 阻塞 / 返回上层）的跨行边只画出口短桩：几乎
    // 每个节点都有「→ 阻塞」出口，整条拉到画布底部会把导轨塞满。
    if (route.next.startsWith("$")) {
      const sx = a.x + a.w;
      const sy = a.y + a.h - 12;
      return [{
        ...common,
        label: "",
        path: `M ${sx} ${sy} L ${sx + 9} ${sy}`,
        arrow: `M ${sx + 9} ${sy - 3} L ${sx + 9} ${sy + 3}`,
        textX: 0, textY: 0, anchor: "start" as const,
      }];
    }
    // 每条导轨边独占一道，道数多了导轨区跟着加宽，连线不再重叠。
    const gx = railX + lanes++ * RAIL_LANE;
    const sx = a.x + a.w;
    const sy = a.y + a.h / 2;
    const ex = b.x + b.w;
    const ey = b.y + b.h / 2;
    const dir = ey > sy ? 1 : -1;
    return [{
      ...common,
      path: `M ${sx} ${sy} L ${gx - 6} ${sy} Q ${gx} ${sy} ${gx} ${sy + 6 * dir} L ${gx} ${ey - 6 * dir} Q ${gx} ${ey} ${gx - 6} ${ey} L ${ex} ${ey}`,
      arrow: `M ${ex + 6} ${ey - 4} L ${ex} ${ey} L ${ex + 6} ${ey + 4}`,
      // 导轨边的标签贴在起点旁（卡片右缘外侧），不在导轨中段漂浮。
      textX: sx + 4, textY: sy - 4, anchor: "start" as const,
    }];
  }));

  // 导轨区：起点偏移 10 + 每道 RAIL_LANE + 右侧留白；少于 5 道时保持原宽。
  const canvasWidth = bandWidth + CANVAS_PAD * 2 + Math.max(LOOP_GUTTER, 10 + lanes * RAIL_LANE + 4);

  const callPath = path.flatMap((frame) => frame.instanceId ? [frame.instanceId] : []);
  const labelOf = (phase: HierarchyFlowPhase) => {
    const child = phase.call ? structure.flows[phase.call] : undefined;
    return (phase.sourceNodeId ? nodeMap.get(phase.sourceNodeId)?.label : undefined) ?? child?.label ?? (phase.connector ? "并行起点" : phase.run.length === 1 ? nodeMap.get(phase.run[0]!)?.label : phase.run.length > 1 ? "并行执行" : phase.id) ?? phase.id;
  };
  const actionCard = (site: string, phase: HierarchyFlowPhase, rect: Rect, index: number) => {
    const solo = phase.run.length === 1;
    const node = nodeMap.get(site);
    if (!node) return null;
    const phaseId = phase.sourcePhaseId ?? phase.id;
    const status = siteState(site, phaseId);
    const record = latestRecord(site, phaseId);
    const progress = record && record.mark !== "superseded" && planOf ? planProgress(planOf(record) ?? []) : null;
    const meta = [cardTime(record?.mark === "superseded" ? undefined : record, now), progress ? `进度 ${progress.done}/${progress.total}` : "",status.count > 1 ? `第 ${status.count} 轮` : ""].filter(Boolean).join(" · ");
    const isSelected = selected === site && (!focusedPhase || focusedPhase === phaseId);
    return <button
      type="button"
      key={site}
      aria-label={`${node.label}，${status.label}`}
      data-site={site}
      data-nav-x={rect.x + (rect.w * (index + 0.5)) / phase.run.length}
      data-nav-y={rect.y + rect.h / 2}
      className={`workflow-card state-${status.state} ${status.awaiting ? "waiting" : ""} ${isSelected ? "selected" : ""} ${solo ? "solo" : ""} ${flashSite === site ? "just-focused" : ""}`}
      onClick={() => onSelect(site, callPath, phaseId)}
    >
      <span className="workflow-card-title"><b data-hint={node.label}>{node.label}</b><i>{kindBadge(node.kind)}</i></span>
      <span className="workflow-card-meta"><StatusWord state={status.state} waiting={status.awaiting} />{meta && <small>{meta}</small>}</span>
      {status.note && <span className={`workflow-card-note ${status.noteAttention ? "attention" : ""}`} data-hint={status.note}>{status.note}</span>}
    </button>;
  };

  return <div className="workflow-protocol-graph" ref={graph} onKeyDown={(event) => {
    if (event.key !== "Escape" || path.length < 2 || event.target instanceof HTMLSelectElement) return;
    event.preventDefault();
    event.stopPropagation();
    refocus.current = current.via ?? "";
    setPath(path.slice(0, -1));
  }}>
    {path.length > 1 && <nav className="workflow-breadcrumb" aria-label="子流程路径">{path.map((frame, index) => <span key={`${frame.flow}:${frame.entry}:${index}`}>{index > 0 && <span aria-hidden="true"> / </span>}<button type="button" onClick={(event) => { if (event.detail === 0) refocus.current = path[index + 1]?.via ?? ""; setPath(path.slice(0, index + 1)); }}>{structure.flows[frame.flow]?.label ?? frame.flow}</button></span>)}</nav>}
    {current.via && instances(current.via, path[path.length - 2]?.instanceId).length > 0 && <div className="workflow-instance-picker">执行实例 <Listbox label="执行实例" value={current.instanceId ?? null} options={instances(current.via, path[path.length - 2]?.instanceId).map((call) => ({ value: call.id, label: `${[`第 ${call.ordinal} 次`, ...Object.values(call.scope).filter(Boolean)].join(" ")} · ${instanceWord(call)}` }))} onChange={(value) => { setPath([...path.slice(0, -1), { ...current, instanceId: value }]); onSelect("", []); }} /></div>}
    <div className="workflow-graph-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
      {bandBoxes.map((band) => band.collapsed
        ? <button key={band.id} type="button" className="workflow-band-summary" data-nav-x={band.rect.x + band.rect.w / 2} data-nav-y={band.rect.y + band.rect.h / 2} style={{ left: band.rect.x, top: band.rect.y, width: band.rect.w, height: band.rect.h }} onClick={() => setExpandedBands(new Set([...expandedBands, band.id]))}>
          <span>{band.tag && <em>{band.tag}</em>}<b>{band.label}</b> · {band.settled} 个节点已完成{band.total > band.settled ? ` · ${band.total - band.settled} 个未触发` : ""}</span><small>展开 ▾</small>
        </button>
        : <div key={band.id || "$all"} className={`workflow-band ${band.active ? "active" : ""} ${band.label ? "" : "untitled"}`} style={{ left: band.rect.x, top: band.rect.y, width: band.rect.w, height: band.rect.h }}>
          {band.label && <div className="workflow-band-head">
            <span>{band.tag && <em>{band.tag}</em>}<b>{band.label}</b>{band.active && <i className={`workflow-live-dot ${snapshot?.active ? "" : "attention"}`} aria-hidden="true" />}</span>
            <span className="workflow-band-count">{expandedBands.has(band.id) && !band.active
              ? <button type="button" onClick={() => setExpandedBands(new Set([...expandedBands].filter((id) => id !== band.id)))}>收起 ▴</button>
              : `${band.settled}/${band.total}`}</span>
          </div>}
        </div>)}
      <svg className="workflow-graph-edges" width={canvasWidth} height={canvasHeight} aria-label="执行关系">{edges.map((edge, index) => <g key={index} data-from={edge.from} data-to={edge.to} data-conditional={edge.conditional ? "true" : undefined} className={`${edge.conditional ? "conditional" : ""} ${edge.tone}`}><path d={edge.path} /><path className="arrow" d={edge.arrow} />{edge.label && <text x={edge.textX} y={edge.textY} textAnchor={edge.anchor}>{edge.label}</text>}</g>)}</svg>
      {items.map(({ phase, rect, current: isCurrent }) => {
        const label = labelOf(phase);
        const style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
        if (phase.connector) return <div key={phase.id} className="workflow-graph-terminal connector" style={style}>并行起点</div>;
        const state = states.get(phase.id) ?? "pending";
        const child = phase.call ? structure.flows[phase.call] : undefined;
        if (child) {
          const { calls, done } = callCounts(phase);
          // 多次执行时，外层就说出是哪一次要人看；「进入」直接打开那一次。
          const flagged = calls.length > 1 ? calls.filter((c) => callAttention(c)) : [];
          const note = flagged.length === 0 ? "" : flagged.length === 1 ? `第 ${flagged[0]!.ordinal} 次${callAttention(flagged[0]!)}` : `${flagged.length} 次需要处理`;
          const progress = phase.foreach && calls.length > 0 ? `已完成 ${done} / ${calls.length}` : "";
          const meta = [progress, note].filter(Boolean).join(" · ");
          return <section key={phase.id} aria-label={label} className={`workflow-phase call state-${state}`} style={style} data-current={isCurrent ? "true" : undefined}>
            <div className="workflow-card solo static">
              <span className="workflow-card-title"><b data-hint={label}>{label}</b><i>{kindBadge("flow")}</i></span>
              <span className="workflow-card-meta"><StatusWord state={state} />{meta && <small className={note ? "attention" : undefined}>{meta}</small>}</span>
              <button className="workflow-graph-call" type="button" data-nav-x={rect.x + rect.w / 2} data-nav-y={rect.y + rect.h / 2} data-nav-call={phase.id} onClick={(event) => { if (event.detail === 0) refocus.current = ""; const call = flagged[0] ?? calls.find((c) => c.status === "running") ?? calls[calls.length - 1]; setPath([...path, { flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: call?.id }]); }}>进入子流程 ›</button>
            </div>
          </section>;
        }
        return <section key={phase.id} aria-label={label} className={`workflow-phase ${phase.run.length > 1 ? "twins" : ""}`} style={style} data-current={isCurrent ? "true" : undefined}>
          {phase.run.map((site, index) => actionCard(site, phase, rect, index))}
        </section>;
      })}
      {[...terminalRects.entries()].map(([id, rect]) => <div key={id} className="workflow-graph-terminal" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>{terminalLabel(id)}</div>)}
    </div>
  </div>;
}

/** 状态点 + 状态词（全面板唯一写法）。 */
export function StatusWord({ state, waiting }: { state: NodeState; waiting?: boolean }) {
  return <span className={`workflow-status state-${state}${waiting ? " waiting" : ""}`}><i aria-hidden="true" />{STATE_LABEL[state]}</span>;
}

/** 卡片高度随内容（规约 §6.2：保证连线不插进上一张卡）：有附注的卡更高。 */
function phaseHeight(phase: HierarchyFlowPhase, views: readonly NodeStatusView[]): number {
  if (phase.connector) return CONNECTOR_H;
  if (phase.call) return CALL_H;
  return CARD_H + (views.some((v) => v.note) ? CARD_NOTE_H : 0);
}

type CanvasExecutionCall = NonNullable<CanvasSnapshot["execution"]>["calls"][number];

function terminalLabel(id: string): string {
  return ({ "$complete": "流程完成", "$blocked": "阻塞", "$return": "返回上层" } as Record<string, string>)[id] ?? id;
}

/** Expand executable node dependencies into graph items without inventing work. */
function expandDependencies(
  flow: HierarchyFlowDefinition,
  entry: string,
  nodeMap: Map<string, WorkflowCatalogNode>,
): { flow: HierarchyFlowDefinition; entry: string } {
  const shouldExpand = (phase: HierarchyFlowPhase) => !!phase.edges?.length || phase.run.some((site) => nodeMap.get(site)?.kind === "flow");
  const ids = (phase: HierarchyFlowPhase) => shouldExpand(phase) ? phase.run.map((site) => JSON.stringify(["node", phase.id, site])) : [phase.id];
  const nodes = new Map(flow.phases.map((p) => [p.id, p]));
  const roots = (id: string): string[] => {
    const p = nodes.get(id);
    if (!p) return [id];
    if (!shouldExpand(p)) return [id];
    return p.run.filter((site) => !p.edges?.some((e) => e.to === site)).map((site) => JSON.stringify(["node", p.id, site]));
  };
  const targets = (routes: readonly HierarchyFlowRoute[]) => routes.flatMap((route) => roots(route.next).map((next) => ({ ...route, next })));
  const phases: HierarchyFlowPhase[] = [];
  for (const phase of flow.phases) {
    if (!shouldExpand(phase)) {
      phases.push({ ...phase, routes: targets(phase.routes) });
      continue;
    }
    phase.run.forEach((site, index) => {
      const outgoing = (phase.edges ?? []).filter((edge) => edge.from === site);
      const routes: HierarchyFlowRoute[] = outgoing.length
        ? outgoing.map((edge) => ({
          next: JSON.stringify(["node", phase.id, edge.to]),
          conditional: edge.when !== undefined && edge.when !== null,
          // 只保留作者写的标签与「允许跳过」；不再给条件边贴通用「条件」。
          label: [edge.label ?? "", edge.optional ? "允许跳过" : ""].filter(Boolean).join(" · "),
        }))
        : targets(phase.routes);
      const node = nodeMap.get(site);
      phases.push({
        id: ids(phase)[index]!,
        stage: phase.stage ?? null,
        sourcePhaseId: phase.id,
        sourceNodeId: site,
        run: node?.kind === "flow" ? [] : [site],
        call: node?.kind === "flow" ? node.call ?? null : null,
        callEntry: node?.kind === "flow" ? node.callEntry ?? null : null,
        routes,
      });
    });
  }
  const first = roots(entry);
  if (first.length > 1) {
    const connector = JSON.stringify(["entry", entry]);
    phases.push({ id: connector, run: [], connector: true, routes: first.map((next) => ({ next, conditional: false })) });
    return { flow: { ...flow, phases }, entry: connector };
  }
  return { flow: { ...flow, phases }, entry: first[0] ?? entry };
}

function reachable(flow: HierarchyFlowDefinition, entry: string): HierarchyFlowPhase[] {
  const map = new Map(flow.phases.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const queue = [entry];
  const out: HierarchyFlowPhase[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = map.get(id);
    if (!p) continue;
    out.push(p);
    for (const route of p.routes) if (map.has(route.next)) queue.push(route.next);
  }
  return out;
}

/**
 * 行序（拓扑秩）：先把真实的环折叠成强连通分量，再让每条无环分支按其最长
 * 前驱分配位置——较短的分支不能把汇合点排到它同样依赖的较长分支之前。
 */
function computeRanks(phases: readonly HierarchyFlowPhase[]): Map<string, number> {
  const map = new Map(phases.map((p) => [p.id, p]));
  const order = new Map(phases.map((p, index) => [p.id, index]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let cursor = 0;
  const visit = (id: string) => {
    index.set(id, cursor);
    low.set(id, cursor++);
    stack.push(id);
    onStack.add(id);
    for (const route of map.get(id)?.routes ?? []) {
      const to = route.next;
      if (!map.has(to)) continue;
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, index.get(to)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let value: string;
      do {
        value = stack.pop()!;
        onStack.delete(value);
        component.push(value);
      } while (value !== id);
      component.sort((a, b) => order.get(a)! - order.get(b)!);
      components.push(component);
    }
  };
  for (const phase of phases) if (!index.has(phase.id)) visit(phase.id);
  const owner = new Map<string, number>();
  components.forEach((component, i) => component.forEach((id) => owner.set(id, i)));
  const outgoing = components.map(() => new Set<number>());
  const incoming = components.map(() => 0);
  const base = components.map(() => 0);
  for (const phase of phases) {
    const from = owner.get(phase.id)!;
    for (const route of phase.routes) {
      const to = owner.get(route.next);
      if (to !== undefined && to !== from && !outgoing[from]!.has(to)) {
        outgoing[from]!.add(to);
        incoming[to] = (incoming[to] ?? 0) + 1;
      }
    }
  }
  const queue = incoming.flatMap((count, i) => count === 0 ? [i] : []);
  while (queue.length) {
    const from = queue.shift()!;
    for (const to of outgoing[from]!) {
      base[to] = Math.max(base[to] ?? 0, (base[from] ?? 0) + components[from]!.length);
      incoming[to] = (incoming[to] ?? 0) - 1;
      if (incoming[to] === 0) queue.push(to);
    }
  }
  const ranks = new Map<string, number>();
  components.forEach((component, i) => component.forEach((id, offset) => ranks.set(id, (base[i] ?? 0) + offset)));
  return ranks;
}
