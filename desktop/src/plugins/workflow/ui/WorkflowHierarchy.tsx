/**
 * 执行关系画布：纵向阶段分带 + 单列主干 + 并行双子卡（UI 原型规约 §6）。
 *
 * 只画执行协议供给的 phase、call 与 route（不发明工作）：
 * - 阶段来自流程定义的 `stages` / `phase.stage`（ADR 025 §2）；定义没有阶段
 *   时整层是一个不带标题的条带，phase 未标注阶段时归入「其他」；
 * - 行序来自 route 的拓扑秩（环先折叠，汇合点排在最长的入边分支之后）；
 *   同秩的 phase、以及一个 phase 内并行的动作，并排成双子卡；
 * - 条带宽度由 GraphCanvas 按视口给出（BAND_MIN…BAND_MAX），低于下限时由
 *   视口横向滚动，画布本身不压缩卡片；
 * - 整带已结束时收成一行摘要；当前节点所在带、选中节点所在带始终展开；
 * - 连线只标定义作者写的标签（「有发现」「复核」），不再给每条条件边贴
 *   「条件 / 其他情况」；条件边用虚线表达。回到上游的边走右侧导轨。
 *
 * 卡片三行（数据全都有，从前只渲染了标题那一行）：
 *   标题（类型图标块 + 名字 + 类型徽标）/ 这一步做什么（`steps`）/ 谁做的 + 状态与用时。
 * 子流程卡多一条脚：子工作流 · N 步 + 步点 + 「进入子流程 ›」。
 *
 * 子流程：进入后顶部换成一条压缩上下文（L2 + 子流程名 + 返回），右侧流程
 * 导航（WorkflowNavigator）用同一份层级路径，可以直接跳到任意层。
 *
 * 键盘：方向键在卡片之间按画布位置移动焦点（不改选中，不打断跟随），
 * Enter 打开节点或进入子流程，Esc 回到上一层。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  HierarchyFlowPhase,
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
import { STATE_TONE, cardTime, kindBadge } from "./nodeText.ts";
import { planProgress, type NodePlanEntry } from "../status/nodePlans.ts";
import { Badge, BadgeDot, Listbox } from "../../../shared/ui/controls.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { ghostButton, secondaryButton } from "./buttons.ts";
import { BotIcon, ChevronRightIcon, MessageCircleIcon, TerminalIcon, WorkflowIcon } from "../../../shared/ui/icons.tsx";
import { BAND_MAX, BAND_MIN, CANVAS_PAD, LOOP_GUTTER } from "./canvasGeometry.ts";
import {
  expandDependencies,
  flowStepCount,
  flowTree,
  framesOf,
  jumpFrame,
  popFrame,
  pushFrame,
  reachable,
  useFlowPath,
  type FlowTreeStep,
} from "./flowPath.ts";
import { useCanvasOverlay, useCanvasStrip } from "./canvasOverlay.ts";
import { WorkflowNavigator, type NavigatorStage } from "./WorkflowNavigator.tsx";

/** 回环导轨上相邻两道的间距。 */
const RAIL_LANE = 7;

const BAND_PAD = 5;
/** 阶段头带：标题行 46 + 底下留 5 空隙（原型 BAND_PAD，头带和第一行卡片不贴死）。 */
const BAND_HEAD = 46;
const BAND_GAP = 26;
const ROW_GAP = 22;
const TWIN_GAP = 10;
const SUMMARY_H = 44;
/** 节点卡：原型 CARD = 84（图标块 26 + 标题 / 做什么 / 谁做·用时三行，行距 3）。 */
const CARD_H = 84;
const CARD_NOTE_H = 20;
/** 子流程卡：原型 CALL = 116（多一条子工作流脚与步点）。 */
const CALL_H = 116;
/** 并行起点的小方块 / 底部的终点胶囊。 */
const CONNECTOR_H = 26;
const TERMINAL_H = 34;

/** 边标签胶囊：字高与文字宽度估算（中文一字宽，西文 0.56 字宽）。 */
const CAPSULE_FONT = 10.5;
const CAPSULE_H = 18;
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

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
  rootLabel,
  planOf,
  sessionFor,
  onOpenSession,
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
  /** 条带宽度（GraphCanvas 按视口算好的 clamp(BAND_MIN, 可用宽, BAND_MAX)）。 */
  bandWidth?: number;
  /** 当前时刻（面板按间隔刷新），用于已运行和等待时长；不给时卡片不显示时间。 */
  now?: number;
  /** 子流程路径第一段的名字（工作流名）；缺省用主流程自己的标签。 */
  rootLabel?: string;
  /** 节点这一轮 Agent 发来的计划（ACP plan）；有计划时卡片显示进度。 */
  planOf?: (record: CanvasNodeSnapshot) => readonly NodePlanEntry[] | null;
  sessionFor?: (record: CanvasNodeSnapshot) => string | undefined;
  onOpenSession?: (sessionId: string) => void;
  onSelect: (site: string, callPath: string[], phaseId?: string) => void;
}) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const target = focusOrdinal !== undefined ? selected : runningSite;
  const targetRecord = snapshot?.nodes.filter((n) => n.siteId === target && (focusOrdinal === undefined || n.ordinal === focusOrdinal)).sort((a, b) => b.ordinal - a.ordinal)[0];
  const { path, current, setPath } = useFlowPath({
    structure,
    entry,
    nodeMap,
    target: target ? { site: target, phaseId: targetRecord?.phaseId ?? undefined, callPath: targetRecord?.callPath } : null,
    snapshot,
  });
  // 展开状态按流程与起点区分，避免在子流程里沿用主流程的同名阶段。
  const bandKey = (id: string) => JSON.stringify([current.flow, current.entry, id]);
  const [expandedBands, setExpandedBands] = useState<ReadonlySet<string>>(() => new Set());
  // 子流程树与浮层宿主：都必须在任何提前 return 之前取，否则每次渲染的 hook 顺序会变。
  const tree = useMemo(() => flowTree(structure, entry, nodeMap), [structure, entry, nodeMap]);
  const overlayHost = useCanvasOverlay();
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

  const flow = structure.flows[current.flow];
  const expanded = useMemo(() => flow ? expandDependencies(flow, current.entry, nodeMap) : null, [flow, current.entry, nodeMap]);
  // 上下文条挂到「不随图缩放」的横条宿主（GraphCanvas 提供，画布外的兄弟层）：
  // 原型 .cz-strip 钉在画布顶部，从前长在内容里跟着 zoom 一起缩放，深三层时
  // L 徽标和返回键都被缩成小字。
  const stripHost = useCanvasStrip();
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
  for (const band of bands) {
    const settledCount = band.phases.filter((p) => isSettled(states.get(p.id) ?? "pending")).length;
    const active = band.phases.some(isCurrentPhase) || band.phases.some(isSelectedPhase);
    const requiresAttention = band.phases.some((phase) =>
      states.get(phase.id) === "failed"
      || snapshot?.gates?.some((gate) => gate.phase === (phase.sourcePhaseId ?? phase.id)),
    );
    const isPinnedOpen = active || requiresAttention;
    const collapsed = band.id !== "" && !isPinnedOpen && !expandedBands.has(bandKey(band.id));
    if (collapsed) {
      const rect = { x: left, y, w: bandWidth, h: SUMMARY_H };
      bandBoxes.push({ id: band.id, label: band.label, tag: band.tag, rect, collapsed, active: isPinnedOpen, settled: settledCount, total: band.phases.length });
      const slot = { rect, row: rowCursor++ };
      for (const phase of band.phases) collapsedAnchor.set(phase.id, slot);
      y += SUMMARY_H + BAND_GAP;
      continue;
    }
    const top = y;
    // 头带 46px + 托盘上边框 1px + 底下留 5 空隙（BAND_PAD）：从前第一行卡片
    // 直接贴着头带底边、还被边框压住 1px —— 用户看到的「头部重叠」就是它。
    y += band.label ? BAND_HEAD + BAND_PAD + 1 : BAND_PAD;
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
    bandBoxes.push({ id: band.id, label: band.label, tag: band.tag, rect: { x: left, y: top, w: bandWidth, h: y - top }, collapsed: false, active: isPinnedOpen, settled: settledCount, total: band.phases.length });
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
  /**
   * 同一个终点被几个节点引用：从前每张卡各伸一根 9px 断头短线（一张表九张卡
   * 就九根，谁也不知道通向哪）。现在同一个终点只画一条边，并在边上写明
   * 「N 个节点可到此」，信息一点没丢，悬空短线归零。
   */
  const terminalSources = new Map<string, string[]>();
  for (const phase of phases) {
    for (const route of phase.routes) {
      if (!route.next.startsWith("$")) continue;
      const list = terminalSources.get(route.next) ?? [];
      if (!list.includes(phase.id)) list.push(phase.id);
      terminalSources.set(route.next, list);
    }
  }

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
    const sources = terminalSources.get(route.next);
    if (sources && sources.length > 1 && sources[0] !== phase.id) return [];
    const a = from.rect;
    const b = to.rect;
    const key = `${a.x},${a.y}>${b.x},${b.y}`;
    if (drawn.has(key) && (collapsedAnchor.has(phase.id) || collapsedAnchor.has(route.next))) return [];
    drawn.add(key);
    const fromState = states.get(phase.id) ?? "pending";
    const toState = route.next.startsWith("$") ? "pending" : states.get(route.next) ?? "pending";
    const label = sources && sources.length > 1 ? `${sources.length} 个节点可到此` : route.label ?? "";
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
        // 箭头是闭合实心三角（原型 arrowV）：开口的 V 加描边在缩放后发虚，闭合后 fill 就是整个形状。
        arrow: `M ${ex - 3.4} ${ey - 5.2} L ${ex} ${ey} L ${ex + 3.4} ${ey - 5.2} Z`,
        textX: (sx + ex) / 2 + 8, textY: mid + 4, anchor: "start" as const,
        capsule: label === "" ? null : capsuleOf(label, (sx + ex) / 2 + 8, mid + 4),
        back: false,
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
      // 水平闭合三角（原型 arrowH）：尖朝终点方向。
      arrow: `M ${ex + 5.2} ${ey - 3.4} L ${ex} ${ey} L ${ex + 5.2} ${ey + 3.4} Z`,
      // 导轨边的标签贴在起点旁（卡片右缘外侧），不在导轨中段漂浮。
      textX: sx + 4, textY: sy - 5, anchor: "start" as const,
      capsule: label === "" ? null : capsuleOf(label, sx + 4, sy - 5),
      back: dir < 0,
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
    const meta = [cardTime(record?.mark === "superseded" ? undefined : record, now, snapshot?.active === false), progress ? `进度 ${progress.done}/${progress.total}` : "",status.count > 1 ? `第 ${status.count} 轮` : ""].filter(Boolean).join(" · ");
    const isSelected = selected === site && (!focusedPhase || focusedPhase === phaseId);
    // Agent 的缺省角色是节点标题，同一角色跨节点使用相同的显示名。
    const who = node.kind === "agent" ? node.role || node.label : kindBadge(node.kind);
    // 第二行说「这一步做什么」：数据模型里一直有（YAML 的 does），从前只在检视器里。
    const what = node.steps.join(" · ");
    const sessionId = record && record.mark !== "superseded" && node.kind === "agent"
      ? sessionFor?.(record)
      : undefined;
    const openSession = sessionId && onOpenSession ? () => onOpenSession(sessionId) : undefined;
    return <div key={site} className={`workflow-card-entry${openSession ? " has-session" : ""}`}>
      <button
        type="button"
        aria-label={`${node.label}，${status.label}`}
        data-site={site}
        data-nav-x={rect.x + (rect.w * (index + 0.5)) / phase.run.length}
        data-nav-y={rect.y + rect.h / 2}
        className={`workflow-card state-${status.state} ${status.awaiting ? "waiting" : ""} ${isSelected ? "selected" : ""} ${solo ? "solo" : ""} ${flashSite === site ? "just-focused" : ""}`}
        onClick={() => onSelect(site, callPath, phaseId)}
      >
        <span className="workflow-card-head">
          <span className={`workflow-card-icon kind-${node.kind}`} aria-hidden="true">{kindIcon(node.kind)}</span>
          <span className="workflow-card-title"><b data-hint={node.label}>{node.label}</b>{node.kind !== "agent" && <Badge compact>{kindBadge(node.kind)}</Badge>}</span>
          {/* 没有运行时（工作流详情的预览图）不写状态：全是「未触发」只是噪音。 */}
          {snapshot && <span className="workflow-card-state"><StatusWord state={status.state} waiting={status.awaiting} /></span>}
        </span>
        {what !== "" && <span className="workflow-card-what" data-hint={node.steps.join("\n")}>{what}</span>}
        <span className="workflow-card-foot">
          <small className="workflow-card-who" data-hint={node.kind === "agent" ? `角色：${who}` : undefined}>{who}</small>
          {meta && <small className="workflow-card-meta-text">{meta}</small>}
        </span>
        {status.note && <span className={`workflow-card-note ${status.noteAttention ? "attention" : ""}`} data-hint={status.note}>{status.note}</span>}
      </button>
      {record && openSession && <IconButton iconSize="compact" type="button" className={`${ghostButton} workflow-card-session`}
        aria-label={`打开「${node.label}」第 ${record.ordinal} 轮会话`} data-hint="打开会话" onClick={openSession}>
        <MessageCircleIcon className="ui-icon-14" />
      </IconButton>}
    </div>;
  };

  // 右侧流程导航用同一份路径与状态：把这一层摊成它能画的数据。
  const navigatorStages: NavigatorStage[] = bands.map((band) => ({
    id: band.id || "$all",
    label: band.label,
    tag: band.tag,
    active: bandBoxes.find((box) => box.id === band.id)?.active ?? false,
    bars: band.phases.flatMap((phase) => phase.call ? [states.get(phase.id) ?? "pending"] : phase.run.map((site) => siteState(site, phase.sourcePhaseId ?? phase.id).state)),
  }));
  const jumpChain = (chain: readonly FlowTreeStep[]) => {
    refocus.current = null;
    setPath(framesOf({ entry, chain, snapshot }));
  };

  return <div className="workflow-protocol-graph" ref={graph} onKeyDown={(event) => {
    if (event.key !== "Escape" || path.length < 2 || event.target instanceof HTMLSelectElement) return;
    event.preventDefault();
    event.stopPropagation();
    const popped = popFrame(path);
    if (!popped) return;
    refocus.current = popped.focus;
    setPath(popped.path);
  }}>
    {path.length > 1 && (stripHost
      ? createPortal(<div className="workflow-context" role="group" aria-label="子流程路径">
        <span className="lvl">L{path.length}</span>
        <span className="now" aria-current="page"><em>子流程：</em>{structure.flows[current.flow]?.label ?? current.flow}</span>
        <button type="button" className={`${secondaryButton} workflow-context-back`} onClick={() => {
          const popped = popFrame(path);
          if (!popped) return;
          setPath(popped.path);
        }}>返回「{path.length > 2 ? structure.flows[path[path.length - 2]!.flow]?.label ?? "" : rootLabel ?? structure.flows[structure.rootFlow]?.label ?? ""}」</button>
      </div>, stripHost)
      // 没有宿主（GraphCanvas 之外独立使用 / 测试环境）：就地渲染，样式同一份。
      : <div className="workflow-context" role="group" aria-label="子流程路径">
        <span className="lvl">L{path.length}</span>
        {path.slice(0, -1).map((frame, index) => <span className="up" key={`${frame.flow}:${index}`}>
          <button type="button" className="crumb" onClick={(event) => {
            // 键盘回到上层时焦点落回进入时的那张卡（鼠标点击不抢焦点）。
            const jumped = jumpFrame(path, index);
            if (!jumped) return;
            if (event.detail === 0) refocus.current = jumped.focus;
            setPath(jumped.path);
          }}>{(index === 0 ? rootLabel : undefined) ?? structure.flows[frame.flow]?.label ?? frame.flow}</button>
          <ChevronRightIcon className="ui-icon-12" aria-hidden="true" />
        </span>)}
        <span className="now" aria-current="page"><em>子流程：</em>{structure.flows[current.flow]?.label ?? current.flow}</span>
        <button type="button" className={`${secondaryButton} workflow-context-back`} onClick={() => {
          const popped = popFrame(path);
          if (!popped) return;
          setPath(popped.path);
        }}>返回「{path.length > 2 ? structure.flows[path[path.length - 2]!.flow]?.label ?? "" : rootLabel ?? structure.flows[structure.rootFlow]?.label ?? ""}」</button>
      </div>)}
    {current.via && instances(current.via, path[path.length - 2]?.instanceId).length > 0 && <div className="workflow-instance-picker">执行实例 <Listbox label="执行实例" value={current.instanceId ?? null} options={instances(current.via, path[path.length - 2]?.instanceId).map((call) => ({ value: call.id, label: `${[`第 ${call.ordinal} 次`, ...Object.values(call.scope).filter(Boolean)].join(" ")} · ${instanceWord(call)}` }))} onChange={(value) => { setPath([...path.slice(0, -1), { ...current, instanceId: value }]); onSelect("", []); }} /></div>}
    <div className="workflow-graph-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
      {bandBoxes.map((band) => band.collapsed
        ? <button key={band.id} type="button" aria-expanded={false} className="workflow-band-summary" data-nav-x={band.rect.x + band.rect.w / 2} data-nav-y={band.rect.y + band.rect.h / 2} style={{ left: band.rect.x, top: band.rect.y, width: band.rect.w, height: band.rect.h }} onClick={() => {
          setExpandedBands(new Set([...expandedBands, bandKey(band.id)]));
        }}>
          {band.tag && <em>{band.tag}</em>}
          <span className="workflow-band-summary-text"><b>{band.label}</b> · {snapshot ? `${band.settled}/${band.total} 已结束` : `${band.total} 步`}</span>
          <small>展开</small>
        </button>
        : <div key={band.id || "$all"} className={`workflow-band ${band.active ? "active" : ""} ${band.label ? "" : "untitled"}`} style={{ left: band.rect.x, top: band.rect.y, width: band.rect.w, height: band.rect.h }}>
          {band.label && <div className="workflow-band-head">
            <span className="workflow-band-title">{band.tag && <em>{band.tag}</em>}<b>{band.label}</b>{band.active && <i className={`workflow-live-dot ${snapshot?.active ? "" : "attention"}`} aria-hidden="true" />}</span>
            <span className="workflow-band-count">
              {`${band.settled}/${band.total} 已完成`}
              {/* 原型里每个阶段头都能收起；正在跑 / 等确认的带不给（收起会挡住你要看的东西）。 */}
              {!band.active && <button type="button" className={ghostButton} aria-label={`收起 ${band.label}`} onClick={() => setExpandedBands(new Set([...expandedBands].filter((id) => id !== bandKey(band.id))))}>收起</button>}
            </span>
          </div>}
        </div>)}
      <svg className="workflow-graph-edges" width={canvasWidth} height={canvasHeight} aria-label="执行关系">{edges.map((edge, index) => <g key={index} data-from={edge.from} data-to={edge.to} data-conditional={edge.conditional ? "true" : undefined} className={`${edge.conditional ? "conditional" : ""} ${edge.tone} ${edge.capsule ? (edge.back ? "labelled-back" : "labelled-fwd") : ""}`}>
        <path d={edge.path} />
        <path className="arrow" d={edge.arrow} />
        {edge.capsule && <rect className="capsule" x={edge.capsule.x} y={edge.capsule.y} width={edge.capsule.width} height={edge.capsule.height} rx={CAPSULE_H / 2} />}
        {edge.label && <text x={edge.textX} y={edge.textY} textAnchor={edge.anchor}>{edge.label}</text>}
      </g>)}</svg>
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
          const steps = flowStepCount(child);
          const source = phase.sourceNodeId ? nodeMap.get(phase.sourceNodeId) : undefined;
          return <section key={phase.id} aria-label={label} className={`workflow-phase call state-${state}`} style={style} data-current={isCurrent ? "true" : undefined}>
            {/* 叠板改成卡自己的下沿双层实边（CSS 里画），不在卡下面塞两块绝对定位的矩形：
                那两块在暖白主题里混出来就是一条黑杠。 */}
            <div className="workflow-card solo static">
              <span className="workflow-card-head">
                <span className="workflow-card-icon kind-flow" aria-hidden="true">{kindIcon("flow")}</span>
                <span className="workflow-card-title"><b data-hint={label}>{label}</b><Badge compact>{kindBadge("flow")}</Badge></span>
                <span className="workflow-card-state"><StatusWord state={state} />{meta && <small className={note ? "attention" : undefined}>{meta}</small>}</span>
              </span>
              {source && source.steps.length > 0 && <span className="workflow-card-what" data-hint={source.steps.join("\n")}>{source.steps.join(" · ")}</span>}
              <span className="workflow-card-subflow">
                <span className="sub">
                  <WorkflowIcon className="ui-icon-14" aria-hidden="true" />
                  <span className="sub-label">子工作流 · {steps} 步</span>
                </span>
                <span className="dots" aria-hidden="true">{Array.from({ length: Math.min(steps, 12) }, (_, index) => <i key={index} />)}</span>
                <button className={`${secondaryButton} workflow-graph-call`} type="button" data-nav-x={rect.x + rect.w / 2} data-nav-y={rect.y + rect.h / 2} data-nav-call={phase.id} onClick={(event) => {
                  if (event.detail === 0) refocus.current = "";
                  const call = flagged[0] ?? calls.find((c) => c.status === "running") ?? calls[calls.length - 1];
                  setPath(pushFrame(path, { flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: call?.id }));
                }}>进入子流程 ›</button>
              </span>
            </div>
          </section>;
        }
        return <section key={phase.id} aria-label={label} className={`workflow-phase ${phase.run.length > 1 ? "twins" : ""}`} style={style} data-current={isCurrent ? "true" : undefined}>
          {phase.run.map((site, index) => actionCard(site, phase, rect, index))}
        </section>;
      })}
      {[...terminalRects.entries()].map(([id, rect]) => <div key={id} className={`workflow-graph-terminal ${TERMINAL_CLASS[id] ?? ""}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>{terminalLabel(id)}</div>)}
    </div>
    {overlayHost && createPortal(<WorkflowNavigator
      rootLabel={rootLabel ?? structure.flows[structure.rootFlow]?.label ?? structure.rootFlow}
      stages={navigatorStages}
      tree={tree}
      isCompact={bandWidth === BAND_MIN}
      activePath={path.map((frame) => frame.flow)}
      onJump={jumpChain}
      onJumpIndex={(index) => {
        const jumped = jumpFrame(path, index);
        if (jumped) setPath(jumped.path);
      }}
    />, overlayHost)}
  </div>;
}

/** 状态点 + 状态词（全面板唯一写法）。 */
/** 状态文字：公共 Badge 加圆点；等你回复时用提醒色。label 缺省用状态词。 */
export function StatusWord({ state, waiting, label }: { state: NodeState; waiting?: boolean; label?: string }) {
  // 外层只带状态标记（小地图按它上色），不参与排版。
  return <span className={`workflow-status contents state-${state}${waiting ? " waiting" : ""}`}>
    <Badge tone={waiting ? "warn" : STATE_TONE[state]} compact>
      <BadgeDot className={`ui-icon-6${state === "running" && !waiting ? " animate-pulse motion-reduce:animate-none" : ""}`} />
      {label ?? STATE_LABEL[state]}
    </Badge>
  </span>;
}

/** 卡片左上角的类型图标块（三种类型各用一个已有图标）。 */
function kindIcon(kind: string) {
  if (kind === "flow") return <WorkflowIcon className="ui-icon-14" />;
  if (kind === "python") return <TerminalIcon className="ui-icon-14" />;
  return <BotIcon className="ui-icon-14" />;
}

/** 卡片高度随内容（规约 §6.2：保证连线不插进上一张卡）：有附注的卡更高。 */
function phaseHeight(phase: HierarchyFlowPhase, views: readonly NodeStatusView[]): number {
  if (phase.connector) return CONNECTOR_H;
  if (phase.call) return CALL_H;
  return CARD_H + (views.some((v) => v.note) ? CARD_NOTE_H : 0);
}

type CanvasExecutionCall = NonNullable<CanvasSnapshot["execution"]>["calls"][number];

/** 终点的语义色：完成 = 通过色，阻塞 = 可修正色；返回上层保持中性。 */
const TERMINAL_CLASS: Record<string, string> = { $complete: "state-ok", $blocked: "state-warn" };

function terminalLabel(id: string): string {
  return ({ "$complete": "流程完成", "$blocked": "阻塞", "$return": "返回上层" } as Record<string, string>)[id] ?? id;
}

/** 标签胶囊的落点：文字写在 (x, y) 基线上，胶囊包住它并留 5px 内边距。 */
function capsuleOf(label: string, x: number, y: number) {
  let width = 10;
  for (const char of label) width += CJK.test(char) ? CAPSULE_FONT : CAPSULE_FONT * 0.56;
  return { x: x - 5, y: y - CAPSULE_H + 4, width: Math.round(width), height: CAPSULE_H };
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
