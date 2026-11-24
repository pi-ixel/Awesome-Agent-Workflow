/**
 * 流程图：上面一行阶段，阶段块底部一排胶囊（一个胶囊一个步骤，颜色是状态）；
 * 点阶段，胶囊本身变成步骤卡挂在阶段正下方；点子流程步骤，向右再展开一列，以此类推。
 *
 * - 阶段之间的先后始终在第一行，展开哪个阶段都不会把整体冲散；
 * - 第一列永远挂在阶段正下方（一条直线连下来），子流程列放不下时把后面的阶段往右推；
 * - 展开前先让位（推开后面的阶段、把屏幕挪过去），收起后再归位；
 * - 直接切到另一个阶段时，当前阶段用 1.5 倍速收回再展开新的；
 * - 回环、分支条件、终点不画在图上：节点详情的「结果怎么走」里有。
 */
import type { SessionLookup } from "../status/snapshot.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import type { CanvasNodeSnapshot, CanvasSnapshot, HierarchyStructure, WorkflowCatalogNode, WorkflowStage } from "../types.ts";
import { STATE_LABEL } from "../status/snapshot.ts";
import { planProgress, type NodePlanEntry } from "../status/nodePlans.ts";
import { cardTime } from "./nodeText.ts";
import { runClock } from "../status/timing.ts";
import { childSteps, flowStages, toneOf, type FlowContext, type FlowStep } from "./flowModel.ts";
import { grow, motionOff, ROOM_MS, shrink, wait } from "./flowMotion.ts";
import { drawMinimap, jumpTo } from "./flowMinimap.ts";
import { observeAppearance } from "../../../shared/ui/observeAppearance.ts";
import { Badge } from "../../../shared/ui/controls.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { CheckIcon, ChevronRightIcon, HandIcon, MessageCircleIcon } from "../../../shared/ui/icons.tsx";
import "./flowStages.css";

/** 子流程列的间距与宽度；第一列和阶段块一样宽。 */
const GAP = 44;
const SUB_W = 224;
const COL_MIN = 224;
/** 阶段行多宽：每个阶段块固定宽（和第一列一样），从左往右排，放不下就让画布横向滚动。 */
const stageRowMin = (count: number) => count * COL_MIN + Math.max(0, count - 1) * 30;
/** 画布左右内边距之和。 */
const PAD = 36;
/** 阶段之间本来的间距（与 .wf-stages 的 column-gap 一致）。 */
const STAGE_GAP = 30;
/** 序号（或对勾）中心离卡片左边的距离（边框 1 + 内边距 12 + 序号位半宽 9）：所有竖线都对着它。 */
const CAP_X = 22;
const ROOM_EASE = "cubic-bezier(.3,.7,.2,1)";

type Open = { readonly stage: string | null; readonly path: readonly string[] };
type Room = { readonly i: number; readonly shift: number; readonly right: number; readonly treeRight: number };

/** 从外面要求定位到某个节点（横幅的「查看」「去处理」）：token 变一次定位一次。 */
export interface FlowReveal {
  readonly site: string;
  readonly phaseId?: string;
  readonly token: number;
}

/**
 * 所有流光从文档时间线的零点算起（进度 = 当前时刻 % 周期）：胶囊和它长成的步骤卡是同一个元素，
 * 变形前后光的位置接得上；几处同时在跑也一起走。
 */
function syncSheen(root: HTMLElement | null): void {
  for (const el of root?.querySelectorAll<HTMLElement>(".wf-pill.tone-running, .wf-step.tone-running") ?? []) {
    for (const anim of el.getAnimations?.() ?? []) {
      if ((anim as CSSAnimation).animationName === "wf-sheen" && anim.startTime !== 0) anim.startTime = 0;
    }
  }
}

export function FlowStages({
  entry,
  structure,
  nodes,
  stages = [],
  snapshot,
  rootLabel,
  label = "流程图",
  selected = "",
  selectedPhase,
  now,
  reveal,
  planOf,
  sessionFor,
  sessionStatus,
  onOpenSession,
  onSelect,
}: {
  entry: string;
  structure: HierarchyStructure;
  nodes: readonly WorkflowCatalogNode[];
  stages?: readonly WorkflowStage[];
  snapshot: CanvasSnapshot | null;
  /** 没有定义阶段时，那一个阶段的名字（工作流名）。 */
  rootLabel?: string;
  label?: string;
  selected?: string;
  selectedPhase?: string;
  /** 当前时刻（面板按间隔刷新），用于已运行和等待时长；不给时卡片不显示时间。 */
  now?: number;
  reveal?: FlowReveal;
  planOf?: (record: CanvasNodeSnapshot) => readonly NodePlanEntry[] | null;
  sessionFor?: (record: CanvasNodeSnapshot) => string | undefined;
  /** 会话的实时状态（ADR 040）：节点卡片的说法与会话一致。 */
  sessionStatus?: SessionLookup;
  onOpenSession?: (sessionId: string) => void;
  /** 点步骤；不给时步骤卡只读（草稿对比的预览图）。 */
  onSelect?: (site: string, callPath: string[], phaseId?: string) => void;
}) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const ctx: FlowContext = useMemo(() => ({ structure, nodeMap, snapshot, session: sessionStatus }), [structure, nodeMap, snapshot, sessionStatus]);
  const views = useMemo(
    () => flowStages(ctx, entry, stages, rootLabel ?? structure.flows[structure.rootFlow]?.label ?? ""),
    [ctx, entry, stages, rootLabel, structure],
  );
  const [open, setOpen] = useState<Open>({ stage: null, path: [] });
  const [flash, setFlash] = useState("");
  const openRef = useRef(open);
  // 动画和观察器在渲染之外读当前展开状态；commit() 也会先写它再同步渲染。
  useLayoutEffect(() => { openRef.current = open; });
  const scroller = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const stageRow = useRef<HTMLDivElement | null>(null);
  const tree = useRef<HTMLDivElement | null>(null);
  const fx = useRef<HTMLDivElement | null>(null);
  const map = useRef<HTMLCanvasElement | null>(null);
  const redrawMap = () => drawMinimap(scroller.current, canvas.current, map.current);
  const busy = useRef(false);
  const hold = useRef(false);
  const room = useRef<Room | null>(null);

  // 展开的各列：第一列是阶段的步骤，之后每列是上一列里点开的子流程。
  const stage = views.find((view) => view.id === open.stage);
  const columns: { owner: string; steps: readonly FlowStep[]; parent?: FlowStep }[] = [];
  if (stage) {
    columns.push({ owner: `g:${stage.id}`, steps: stage.steps });
    for (let depth = 0; depth < open.path.length; depth++) {
      const parent = columns[depth]!.steps.find((step) => step.key === open.path[depth] && step.child);
      if (!parent) break;
      columns.push({ owner: `f:${depth}:${parent.key}`, steps: childSteps(ctx, parent), parent });
    }
  }

  // ------------------------------------------------------------ 布局（直接量 DOM：动画要的就是这些位置）
  const viewW = () => (scroller.current?.clientWidth ?? 0) - PAD;
  const blocks = () => [...(stageRow.current?.children ?? [])] as HTMLElement[];
  const stageIndex = (id: string | null) => views.findIndex((view) => view.id === id);
  function roomFor(stageId: string | null, depth: number): Room {
    const all = blocks();
    const i = stageIndex(stageId);
    const block = all[i];
    if (!block) return { i: -1, shift: 0, right: viewW(), treeRight: 0 };
    const treeRight = block.offsetLeft + Math.max(block.offsetWidth, COL_MIN) + depth * (GAP + SUB_W);
    const next = all[i + 1];
    // 和阶段之间本来的间距（30）一样宽就不用推；只有展开的列伸到后一个阶段下面才推开。
    const shift = next ? Math.max(0, treeRight + STAGE_GAP - next.offsetLeft) : 0;
    const last = all[all.length - 1]!;
    const right = Math.max(viewW(), treeRight, last.offsetLeft + last.offsetWidth + (next ? shift : 0));
    return { i, shift, right, treeRight };
  }
  // 推开一个阶段：块本身平移，它前面那条连线同步拉长，左端始终贴着前一个阶段。
  // reach：它前面那条连线的长度；只有紧挨着展开阶段的那一条要拉长，再往后的阶段整体平移、连线不变。
  function placeBlock(block: HTMLElement, shift: number, animate: boolean, reach = shift): void {
    block.style.transition = animate ? `transform ${ROOM_MS}ms ${ROOM_EASE}` : "";
    block.style.setProperty("--wf-link-ms", animate ? `${ROOM_MS}ms` : "0ms");
    block.style.transform = shift ? `translateX(${shift}px)` : "";
    block.style.setProperty("--wf-reach", `${STAGE_GAP + reach}px`);
  }
  function paintRoom(animate: boolean): void {
    const r = room.current;
    blocks().forEach((block, k) => {
      const shift = r && r.i >= 0 && k > r.i ? r.shift : 0;
      placeBlock(block, shift, animate, r && k === r.i + 1 ? shift : 0);
    });
    // 放得下就不定宽（随视口，纵向滚动条出现时也不会多出横向滚动）；放不下才撑宽。
    const right = Math.max(r && r.i >= 0 ? r.right : 0, stageRowMin(views.length));
    if (canvas.current) canvas.current.style.width = right > viewW() + 1 ? `${right + PAD}px` : "";
  }
  function layout(): void {
    const host = tree.current;
    const row = stageRow.current;
    if (!host || !row) return;
    row.style.width = `${Math.max(viewW(), stageRowMin(views.length))}px`;
    const cols = [...host.querySelectorAll<HTMLElement>(":scope > .wf-col")];
    const block = blocks()[stageIndex(openRef.current.stage)];
    if (!cols.length || !block) {
      if (!hold.current) host.style.height = "0px";
      return;
    }
    const x = block.offsetLeft;
    let bottom = 0;
    cols.forEach((col, depth) => {
      if (depth === 0) {
        Object.assign(col.style, { left: `${x}px`, top: "0px", width: `${Math.max(block.offsetWidth, COL_MIN)}px` });
      } else {
        const prev = cols[depth - 1]!;
        const node = [...prev.querySelectorAll<HTMLElement>(":scope > .wf-step")].find((el) => el.dataset.key === openRef.current.path[depth - 1]);
        if (!node) return;
        Object.assign(col.style, {
          left: `${parseFloat(prev.style.left) + prev.offsetWidth + GAP}px`,
          top: `${parseFloat(prev.style.top) + node.offsetTop}px`,
          width: `${SUB_W}px`,
        });
        col.style.setProperty("--wf-gap", `${GAP}px`);
        col.style.setProperty("--wf-cy", `${node.offsetHeight / 2 - 1}px`);
      }
      bottom = Math.max(bottom, parseFloat(col.style.top) + col.offsetHeight);
    });
    if (!hold.current) host.style.height = `${bottom}px`;
    // 阶段到第一列：一条竖线，从阶段块底边直下（阶段块展开后变矮，所以每次量）。
    const line = host.querySelector<HTMLElement>(":scope > .wf-hang");
    if (line) {
      const gap = host.getBoundingClientRect().top - block.getBoundingClientRect().bottom;
      Object.assign(line.style, { left: `${x + CAP_X - 1}px`, top: `${-gap}px`, height: `${Math.max(0, gap)}px` });
    }
  }
  useLayoutEffect(() => {
    syncSheen(scroller.current);
    layout();
    redrawMap();
    // 不在动画里（例如外部定位、重新加载）：让位直接到位。
    if (!busy.current) {
      room.current = open.stage ? roomFor(open.stage, columns.length - 1) : null;
      paintRoom(false);
    }
  });
  // 面板变宽变窄：重新量。观察器只建一次，量的时候用最新的函数。
  const relayout = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    relayout.current = () => {
      if (busy.current) return;
      layout();
      room.current = openRef.current.stage ? roomFor(openRef.current.stage, openRef.current.path.length) : null;
      paintRoom(false);
      redrawMap();
    };
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => relayout.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = scroller.current?.ownerDocument.documentElement;
    if (!root) return;
    return observeAppearance(root, ({ fontChanged }) => {
      if (fontChanged) relayout.current();
      else drawMinimap(scroller.current, canvas.current, map.current);
    });
  }, []);
  const mapFrame = useRef(0);
  const onScroll = () => {
    if (mapFrame.current) return;
    mapFrame.current = requestAnimationFrame(() => {
      mapFrame.current = 0;
      drawMinimap(scroller.current, canvas.current, map.current);
    });
  };
  const onMapPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.type === "pointermove" && !(event.buttons & 1)) return;
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture?.(event.pointerId);
    if (scroller.current && canvas.current) jumpTo(scroller.current, canvas.current, event.currentTarget, event.clientX, event.clientY);
  };

  // ------------------------------------------------------------ 展开 / 收起
  const byOwner = (selector: string, owner: string) =>
    [...(scroller.current?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((el) => el.dataset.k?.startsWith(`${owner}/`));
  const toneColor = (tone: string) => getComputedStyle(scroller.current!).getPropertyValue(`--wf-${tone}`).trim();
  const commit = (next: Open) => {
    openRef.current = next;
    flushSync(() => setOpen(next));
  };
  async function makeRoom(stageId: string | null, depth: number): Promise<void> {
    const before = room.current?.shift ?? 0;
    room.current = roomFor(stageId, depth);
    paintRoom(true);
    const view = scroller.current!;
    const target = Math.max(0, room.current.treeRight + PAD - view.clientWidth);
    const scroll = target > view.scrollLeft + 1;
    if (scroll) view.scrollTo?.({ left: target, behavior: motionOff() ? "auto" : "smooth" });
    if (room.current.shift !== before || scroll) await wait(ROOM_MS + 40);
  }
  async function releaseRoom(stageId: string | null, depth: number): Promise<void> {
    const before = room.current?.shift ?? 0;
    const next = roomFor(stageId, depth);
    room.current = next.i >= 0 ? next : null;
    // 先归位、挪回屏幕，最后再收窄画布（不然浏览器会硬把滚动位置夹回去）。
    blocks().forEach((block, k) => {
      const shift = next.i >= 0 && k > next.i ? next.shift : 0;
      placeBlock(block, shift, true, k === next.i + 1 ? shift : 0);
    });
    const view = scroller.current!;
    const max = Math.max(0, next.right + PAD - view.clientWidth);
    const scroll = view.scrollLeft > max + 1;
    if (scroll) view.scrollTo?.({ left: max, behavior: motionOff() ? "auto" : "smooth" });
    if (next.shift !== before || scroll) await wait(ROOM_MS + 40);
    paintRoom(false);
  }
  async function expand(owner: string, next: Open): Promise<void> {
    const before = new Map(byOwner(".wf-pill", owner).map((pill) => [pill.dataset.k!, pill.getBoundingClientRect()]));
    commit(next);
    if (motionOff()) return;
    const cards = byOwner(".wf-col > .wf-step", owner).filter((card) => before.has(card.dataset.k!));
    await Promise.all(cards.map((card, index) => grow(card, before.get(card.dataset.k!)!, toneColor(card.dataset.tone ?? "wait"), index)));
  }
  async function collapse(owner: string, next: Open, sp = 1): Promise<void> {
    const host = tree.current!;
    const layer = fx.current;
    const clones = motionOff() || !layer ? [] : byOwner(".wf-col > .wf-step", owner).map((card) => {
      const r = card.getBoundingClientRect();
      const copy = card.cloneNode(true) as HTMLElement;
      Object.assign(copy.style, { position: "fixed", margin: "0", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.appendChild(copy);
      return copy;
    });
    const keep = host.offsetHeight;
    hold.current = true;
    host.style.height = `${keep}px`;
    commit(next);
    const pills = new Map(byOwner(".wf-pill", owner).map((pill) => [pill.dataset.k!, pill]));
    await Promise.all(clones.map((copy, index) => {
      const pill = pills.get(copy.dataset.k!);
      if (!pill) { copy.remove(); return Promise.resolve(); }
      pill.style.opacity = "0";
      return shrink(copy, pill.getBoundingClientRect(), toneColor(copy.dataset.tone ?? "wait"), index, sp).then(() => {
        pill.style.opacity = "";
        copy.remove();
      });
    }));
    // 节点都落回胶囊后，画布再顺滑收短。
    if (!next.stage && clones.length) await host.animate([{ height: `${keep}px` }, { height: "0px" }], { duration: 220 / sp, easing: "ease-out" }).finished.catch(() => undefined);
    hold.current = false;
    layout();
  }
  async function dropDeeper(depth: number, sp = 1): Promise<void> {
    const current = openRef.current;
    if (current.path.length <= depth) return;
    const cols = [...(tree.current?.querySelectorAll<HTMLElement>(":scope > .wf-col") ?? [])].filter((col) => Number(col.dataset.depth) > depth);
    if (!motionOff()) {
      await Promise.all(cols.map((col) => col.animate([{ opacity: 1 }, { opacity: 0, transform: "translateX(-8px)" }], { duration: 150 / sp, fill: "forwards" }).finished.catch(() => undefined)));
    }
    commit({ stage: current.stage, path: current.path.slice(0, depth) });
  }
  async function exclusive(task: () => Promise<void>): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    try {
      await task();
    } finally {
      busy.current = false;
      redrawMap();
    }
  }
  const toggleStage = (id: string) => exclusive(async () => {
    const was = openRef.current.stage;
    const sp = was && was !== id ? 1.5 : 1;
    if (was) {
      await dropDeeper(0, sp);
      await collapse(`g:${was}`, { stage: null, path: [] }, sp);
      await releaseRoom(null, 0);
    }
    if (was !== id) {
      await makeRoom(id, 0);
      await expand(`g:${id}`, { stage: id, path: [] });
    }
  });
  const toggleFlow = (depth: number, key: string) => exclusive(async () => {
    const current = openRef.current;
    const was = current.path[depth];
    if (was) {
      await dropDeeper(depth + 1);
      await collapse(`f:${depth}:${was}`, { stage: current.stage, path: current.path.slice(0, depth) });
    }
    if (was === key) {
      await releaseRoom(current.stage, depth);
    } else {
      await makeRoom(current.stage, depth + 1);
      await expand(`f:${depth}:${key}`, { stage: current.stage, path: [...current.path.slice(0, depth), key] });
    }
  });

  // ------------------------------------------------------------ 外部定位
  // token 变一次就展开到那个节点（渲染期调整状态，不在副作用里 setState）。
  const [seenReveal, setSeenReveal] = useState(0);
  if (reveal && reveal.token !== seenReveal) {
    setSeenReveal(reveal.token);
    const match = (step: FlowStep) => step.site === reveal.site && (!reveal.phaseId || reveal.phaseId === step.phaseId);
    const search = (steps: readonly FlowStep[], path: string[], depth: number): string[] | null => {
      if (steps.some(match)) return path;
      if (depth > 6) return null;
      for (const step of steps) {
        if (!step.child) continue;
        const found = search(childSteps(ctx, step), [...path, step.key], depth + 1);
        if (found) return found;
      }
      return null;
    };
    for (const view of views) {
      const path = search(view.steps, [], 0);
      if (!path) continue;
      setOpen({ stage: view.id, path });
      setFlash(reveal.site);
      break;
    }
  }
  // 定位到的卡片滚进视野，外圈闪一下再淡掉。
  useEffect(() => {
    if (!flash) return;
    const frame = requestAnimationFrame(() => {
      const card = [...(scroller.current?.querySelectorAll<HTMLElement>(".wf-step") ?? [])].find((el) => el.dataset.site === flash);
      card?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
    });
    const timer = setTimeout(() => setFlash(""), 1500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [flash, seenReveal]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const { stage: id, path } = openRef.current;
    if (event.key !== "Escape" || !id || busy.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (path.length) {
      const depth = path.length - 1;
      const key = path[depth]!;
      const parent = [...(tree.current?.querySelectorAll<HTMLElement>(".wf-col > .wf-step") ?? [])]
        .find((step) => step.dataset.key === key && Number(step.parentElement?.dataset.depth) === depth);
      parent?.querySelector<HTMLButtonElement>("button.wf-step-main")?.focus({ preventScroll: true });
      void toggleFlow(depth, key);
    } else {
      const stage = [...(stageRow.current?.querySelectorAll<HTMLButtonElement>(".wf-stage") ?? [])]
        .find((button) => button.dataset.stage === id);
      stage?.focus({ preventScroll: true });
      void toggleStage(id);
    }
  };

  // ------------------------------------------------------------ 呈现
  const pills = (owner: string, steps: readonly FlowStep[], hidden = false) => <span className={`wf-pills${hidden ? " gone" : ""}`} aria-hidden="true">
    {steps.map((step) => <i key={step.key} className={`wf-pill tone-${toneOf(step)}`} data-k={`${owner}/${step.key}`} />)}
  </span>;

  const stepCard = (step: FlowStep, index: number, owner: string, depth: number) => {
    const tone = toneOf(step);
    const k = `${owner}/${step.key}`;
    const no = String(index + 1).padStart(2, "0");
    const isOpen = !!step.child && open.path[depth] === step.key;
    const isSelected = !!step.site && step.site === selected && (!selectedPhase || selectedPhase === step.phaseId);
    const word = !snapshot ? "" : step.status && step.status.state === step.state ? step.status.label : STATE_LABEL[step.state];
    const record = step.record && step.record.mark !== "superseded" ? step.record : undefined;
    const progress = record && planOf ? planProgress(planOf(record) ?? []) : null;
    const meta = [cardTime(record, now === undefined ? undefined : runClock(snapshot, now)), progress ? `进度 ${progress.done}/${progress.total}` : "", (step.status?.count ?? 0) > 1 ? `第 ${step.status!.count} 轮` : ""].filter(Boolean).join(" · ");
    const sessionId = record && step.node?.kind === "agent" ? sessionFor?.(record) : undefined;
    // 卡片本身就是胶囊的颜色；已完成不再写字，序号换成一个圆形对勾。
    const done = step.state === "done" || step.state === "done-findings";
    const shown = step.state === "done" ? "" : step.state === "done-findings" ? "曾报告发现" : word;
    const head = <span className="wf-step-row">
      {done
        ? <span className="wf-no wf-done-mark" role="img" aria-label="已完成"><CheckIcon className="ui-icon-10" /></span>
        : <span className="wf-no">{no}</span>}
      <b data-hint={step.label}>{step.label}</b>
      {step.node?.kind === "python" && <Badge compact>脚本</Badge>}
      {step.child?.tag && <span className="wf-tag">{step.child.tag}</span>}
      {step.confirm && <HandIcon className="ui-icon-12 wf-confirm" aria-label="完成后等你确认" data-hint="完成后等你确认" />}
      {shown && !step.child && <span className={`wf-word tone-${tone}`}>{shown}</span>}
    </span>;
    const body = <>
      {head}
      {step.does && <small className="wf-does" data-hint={step.does}>{step.does}</small>}
      {meta && <small className="wf-meta">{meta}</small>}
      {step.status?.note && <small className={`wf-note${step.status.noteAttention ? " attention" : ""}`}>{step.status.note}</small>}
      {step.stop && <small className="wf-note wf-stop" data-hint={step.stop}>{step.stop}</small>}
      {step.child && pills(`f:${depth}:${step.key}`, childSteps(ctx, step), isOpen)}
    </>;
    return <div key={step.key} className={`wf-step tone-${tone}${step.child ? " is-flow" : ""}${isOpen ? " open" : ""}${isSelected ? " selected" : ""}${flash && step.site === flash ? " flash" : ""}${sessionId ? " has-session" : ""}`}
      data-k={k} data-key={step.key} data-tone={tone} data-site={step.site}>
      {step.child
        ? <NavigationRow layout="compound" className="wf-step-main" aria-expanded={isOpen} aria-label={`${step.label}${word ? `，${word}` : ""}，${isOpen ? "收起" : "展开"}子流程`} onClick={() => void toggleFlow(depth, step.key)}>
          {body}<ChevronRightIcon className="ui-icon-16 wf-chevron" aria-hidden="true" />
        </NavigationRow>
        : onSelect && step.site
          ? <NavigationRow layout="compound" className="wf-step-main" aria-pressed={isSelected} aria-label={`${step.label}${word ? `，${word}` : ""}`} onClick={() => onSelect(step.site!, [...step.callPath], step.phaseId)}>{body}</NavigationRow>
          : <div className="wf-step-main" role="group" aria-label={step.label}>{body}</div>}
      {sessionId && onOpenSession && <IconButton iconSize="compact" type="button" className="wf-session" aria-label={`打开「${step.label}」第 ${record!.ordinal} 轮会话`} data-hint="打开会话" onClick={() => onOpenSession(sessionId)}>
        <MessageCircleIcon className="ui-icon-14" />
      </IconButton>}
    </div>;
  };

  return <div className="wf-flow" role="region" aria-label={label} onKeyDown={onKeyDown}>
    <div className="wf-scroller" ref={scroller} onScroll={onScroll}>
      <div className="wf-canvas" ref={canvas}>
        <div className="wf-stages" ref={stageRow} style={{ gridTemplateColumns: `repeat(${Math.max(1, views.length)}, ${COL_MIN}px)` }}>
          {views.map((view) => {
            const isOpen = open.stage === view.id;
            const tone = toneOf(view);
            const names = view.steps.map((step) => step.label).join(" → ");
            const subtitle =
              view.steps.length > 1
                ? names
                : view.steps[0]?.does && view.steps[0].does !== view.label
                  ? view.steps[0].does
                  : "";
            return <NavigationRow layout="compound" key={view.id} className={`wf-stage${isOpen ? " open" : ""}`} data-stage={view.id} aria-expanded={isOpen}
              aria-label={`${view.no} ${view.label}，${view.word}，${isOpen ? "收起" : "展开"}步骤`} onClick={() => void toggleStage(view.id)}>
              {/* 左边序号圆是视觉重点，颜色就是状态（完成换成对勾）；右边名字、步骤名、胶囊 */}
              <span className={`wf-stage-mark tone-${tone}`} aria-hidden="true">{tone === "done" ? <CheckIcon className="ui-icon-14" /> : view.no}</span>
              <span className="wf-stage-body">
                <span className="wf-stage-head">
                  <b className="wf-stage-title" data-hint={view.label}>{view.label}</b>
                  {snapshot && (tone === "running" || tone === "alert") && <span className={`wf-word tone-${tone}`}>{view.word}</span>}
                </span>
                {subtitle && <small className="wf-stage-span" data-hint={subtitle}>{subtitle}</small>}
                {pills(`g:${view.id}`, view.steps, isOpen)}
              </span>
            </NavigationRow>;
          })}
        </div>
        <div className="wf-tree" ref={tree}>
          {columns.length > 0 && <i className="wf-hang" aria-hidden="true" />}
          {columns.map((column, depth) => <div key={column.owner} className={`wf-col${depth ? " sub" : ""}`} data-depth={depth}>
            {column.parent && <div className="wf-col-head"><b>{structure.flows[column.parent.child!.frame.flow]?.label ?? column.parent.label}</b><span>{[column.parent.child!.tag, `${column.steps.length} 步`].filter(Boolean).join(" · ")}</span></div>}
            {column.steps.map((step, index) => stepCard(step, index, column.owner, depth))}
          </div>)}
        </div>
      </div>
    </div>
    {/* 小地图：内容放不下时淡入（drawMinimap 切换 show） */}
    <div className="wf-map" aria-hidden="true">
      <canvas ref={map} onPointerDown={onMapPointer} onPointerMove={onMapPointer} />
    </div>
    {typeof document !== "undefined" && createPortal(<div className="wf-fx" ref={fx} aria-hidden="true" inert />, document.body)}
  </div>;
}
