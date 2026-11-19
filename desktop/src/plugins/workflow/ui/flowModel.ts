/**
 * 流程图的数据模型：把定义（阶段 / phase / 子流程）和运行快照整理成
 * 「阶段 → 一串步骤 → 子流程再是一串步骤」。
 *
 * 只整理执行协议给出的东西，不发明工作：
 * - 阶段来自定义的 `stages` / `phase.stage`；定义没有阶段时整层是一个阶段，
 *   phase 没标阶段时归入「其他」；
 * - 一串步骤的先后来自 route 的拓扑秩（环先折叠，汇合点排在最长的入边分支之后）；
 *   一个 phase 里并行的几个动作各算一步；
 * - 子流程调用是一步，它自己的步骤要点开才看；多次执行（逐项）时看正在跑的那一次，
 *   没在跑就看最近一次。
 */
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
import { isSettled, mergeStates, nodeStatus, STATE_LABEL, type NodeState, type NodeStatusView } from "../status/snapshot.ts";

/** 看的是哪一层：哪条流程、从哪个入口进、由哪一步调用进来、哪一次执行实例。 */
export interface FlowFrame {
  readonly flow: string;
  readonly entry: string;
  /** 调用它的那一步（根层没有）。 */
  readonly via?: string;
  readonly instanceId?: string;
}

export interface FlowStep {
  /** 在这一层里唯一：phase id，动作步骤再加节点 id。 */
  readonly key: string;
  /** 定义里的 phase（选中节点、打开详情用）。 */
  readonly phaseId: string;
  /** 动作节点；子流程步骤没有。 */
  readonly site?: string;
  readonly node?: WorkflowCatalogNode;
  readonly label: string;
  /** 这一步做什么（定义的 `does`）。 */
  readonly does: string;
  readonly state: NodeState;
  /** 在等你回复或确认：要你马上处理。 */
  readonly attention: boolean;
  readonly status?: NodeStatusView;
  readonly record?: CanvasNodeSnapshot;
  /** 走出这一步的某条去向要你确认。 */
  readonly confirm: boolean;
  /** 子流程步骤：点开看的那一层，以及卡片上的小字（「已完成 2 / 4」）。 */
  readonly child?: { readonly frame: FlowFrame; readonly tag: string };
  /** 执行实例链（选中节点时交给详情）。 */
  readonly callPath: readonly string[];
}

export interface FlowStageView {
  readonly id: string;
  readonly no: string;
  readonly label: string;
  readonly state: NodeState;
  readonly attention: boolean;
  /** 阶段块右上角那句：「已完成」「运行中」「9 步」…… */
  readonly word: string;
  readonly steps: readonly FlowStep[];
}

export interface FlowContext {
  readonly structure: HierarchyStructure;
  readonly nodeMap: ReadonlyMap<string, WorkflowCatalogNode>;
  readonly snapshot: CanvasSnapshot | null;
}

type Call = NonNullable<CanvasSnapshot["execution"]>["calls"][number];

/**
 * 展开可执行节点的依赖：一个 phase 里带 edges 的多个动作拆成各自的一步，
 * 子流程节点拆成调用。不发明工作，只把已有的 phase.run 摊开。
 */
export function expandDependencies(
  flow: HierarchyFlowDefinition,
  entry: string,
  nodeMap: ReadonlyMap<string, WorkflowCatalogNode>,
): { flow: HierarchyFlowDefinition; entry: string } {
  const shouldExpand = (phase: HierarchyFlowPhase) => !!phase.edges?.length || phase.run.some((site) => nodeMap.get(site)?.kind === "flow");
  const nodes = new Map(flow.phases.map((p) => [p.id, p]));
  const idOf = (phase: HierarchyFlowPhase, site: string) => JSON.stringify(["node", phase.id, site]);
  const roots = (id: string): string[] => {
    const p = nodes.get(id);
    if (!p || !shouldExpand(p)) return [id];
    return p.run.filter((site) => !p.edges?.some((e) => e.to === site)).map((site) => idOf(p, site));
  };
  const targets = (routes: readonly HierarchyFlowRoute[]) => routes.flatMap((route) => roots(route.next).map((next) => ({ ...route, next })));
  const phases: HierarchyFlowPhase[] = [];
  for (const phase of flow.phases) {
    if (!shouldExpand(phase)) {
      phases.push({ ...phase, routes: targets(phase.routes) });
      continue;
    }
    for (const site of phase.run) {
      const outgoing = (phase.edges ?? []).filter((edge) => edge.from === site);
      const node = nodeMap.get(site);
      phases.push({
        id: idOf(phase, site),
        stage: phase.stage ?? null,
        sourcePhaseId: phase.id,
        sourceNodeId: site,
        run: node?.kind === "flow" ? [] : [site],
        call: node?.kind === "flow" ? node.call ?? null : null,
        callEntry: node?.kind === "flow" ? node.callEntry ?? null : null,
        routes: outgoing.length
          ? outgoing.map((edge) => ({ next: idOf(phase, edge.to), conditional: edge.when !== undefined && edge.when !== null }))
          : targets(phase.routes),
      });
    }
  }
  const first = roots(entry);
  if (first.length > 1) {
    // 入口同时起几个动作：放一个不显示的起点，让它们都可达。
    const connector = JSON.stringify(["entry", entry]);
    phases.push({ id: connector, run: [], connector: true, routes: first.map((next) => ({ next, conditional: false })) });
    return { flow: { ...flow, phases }, entry: connector };
  }
  return { flow: { ...flow, phases }, entry: first[0] ?? entry };
}

/** 从这个入口能走到的 phase（顺着 routes 走，环只进一次）。 */
export function reachable(flow: HierarchyFlowDefinition, entry: string): HierarchyFlowPhase[] {
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
 * 先后（拓扑秩）：先把真实的环折叠成强连通分量，再让每条无环分支按其最长
 * 前驱分配位置——较短的分支不能把汇合点排到它同样依赖的较长分支之前。
 */
export function computeRanks(phases: readonly HierarchyFlowPhase[]): Map<string, number> {
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

/** 一层里按先后排好的 phase（不含不显示的并行起点）。 */
function orderedPhases(ctx: FlowContext, frame: FlowFrame): { phases: HierarchyFlowPhase[]; source: HierarchyFlowDefinition } | null {
  const flow = ctx.structure.flows[frame.flow];
  if (!flow) return null;
  const expanded = expandDependencies(flow, frame.entry, ctx.nodeMap);
  const phases = reachable(expanded.flow, expanded.entry);
  const ranks = computeRanks(phases);
  const order = new Map(phases.map((p, i) => [p.id, i]));
  return {
    phases: phases.filter((p) => !p.connector).sort((a, b) => (ranks.get(a.id)! - ranks.get(b.id)!) || (order.get(a.id)! - order.get(b.id)!)),
    source: flow,
  };
}

/** 一层里的状态计算（从前在画布组件里，按当前层写死；现在按层传入）。 */
function frameState(ctx: FlowContext, frame: FlowFrame) {
  const { snapshot } = ctx;
  const runResult = snapshot?.run && typeof snapshot.run.result === "object" && snapshot.run.result !== null ? snapshot.run.result as Record<string, unknown> : null;
  const activePhases = new Set([snapshot?.execution?.phase, ...(snapshot?.execution?.stack ?? []).map((f) => f.phase)]);
  const calls = snapshot?.execution?.calls ?? [];
  const isActiveHere = !frame.via || !!frame.instanceId && calls.some((call) => call.id === frame.instanceId && call.status === "running");
  const inHere = (record: CanvasNodeSnapshot) => !frame.via || !!frame.instanceId && !!record.callPath?.includes(frame.instanceId);
  const instances = (phase: string): Call[] => frame.via && !frame.instanceId ? [] : calls.filter((c) => c.phase === phase && c.parent === (frame.instanceId ?? null));
  const latest = (site: string, phaseId: string) =>
    snapshot?.nodes.filter((n) => n.siteId === site && n.phaseId === phaseId && inHere(n)).sort((a, b) => b.ordinal - a.ordinal)[0];
  const siteState = (site: string, phaseId: string): NodeStatusView => {
    const record = latest(site, phaseId);
    if (!snapshot || !record) return nodeStatus({ id: site }, null);
    return nodeStatus({ id: site }, { ...snapshot, nodes: [record] });
  };
  const callState = (phase: HierarchyFlowPhase): NodeState => {
    if (!snapshot) return "pending";
    const list = instances(phase.id);
    if (phase.sourceNodeId) {
      const last = list.reduce<Call | undefined>((acc, call) => !acc || call.ordinal > acc.ordinal ? call : acc, undefined);
      const record = latest(phase.sourceNodeId, phase.sourcePhaseId ?? phase.id);
      if (record?.status === "skipped" && (!last || record.ordinal > last.ordinal)) return "skipped";
      if (!last) return "pending";
      if (last.status === "failed") return "failed";
      if (last.status === "running") return snapshot.active ? "running" : "stuck";
      return last.status === "completed" ? "done" : "pending";
    }
    if (!list.length) return "pending";
    if (list.some((c) => c.status === "failed")) return "failed";
    if (list.some((c) => c.status === "running")) return snapshot.active ? "running" : runResult?.status === "blocked" ? "blocked" : "stuck";
    return list.every((c) => c.status === "completed") ? "done" : "pending";
  };
  const actionState = (phase: HierarchyFlowPhase, view: NodeStatusView): NodeState => {
    if (!snapshot) return "pending";
    if (isActiveHere && runResult?.status === "blocked" && runResult?.stage === (phase.sourcePhaseId ?? phase.id)) return "blocked";
    // 执行位置就在这一步、服务仍在跑：即使记录尚未落账也是「运行中」。
    if (snapshot.active && isActiveHere && activePhases.has(phase.sourcePhaseId ?? phase.id) && !isSettled(view.state)) return "running";
    return view.state;
  };
  return { instances, latest, siteState, callState, actionState };
}

/** 子流程调用里有没有要你处理的事：等回复优先，其次是失败。 */
function callNeedsYou(ctx: FlowContext, call: Call): boolean {
  return (ctx.snapshot?.active === true && ctx.snapshot.nodes.some((n) => n.status === "running" && n.awaitingInput === true && n.callPath?.includes(call.id)))
    || call.status === "failed";
}

/** 一层的步骤。 */
export function frameSteps(ctx: FlowContext, frame: FlowFrame, callPath: readonly string[] = []): FlowStep[] {
  const ordered = orderedPhases(ctx, frame);
  if (!ordered) return [];
  const s = frameState(ctx, frame);
  const gates = ctx.snapshot?.gates ?? [];
  const steps: FlowStep[] = [];
  for (const phase of ordered.phases) {
    const phaseId = phase.sourcePhaseId ?? phase.id;
    const confirm = phase.routes.some((route) => !!route.confirm);
    const child = phase.call ? ctx.structure.flows[phase.call] : undefined;
    if (child) {
      const list = s.instances(phase.id);
      // 点开看哪一次：要你处理的那次，其次正在跑的，否则最近一次。
      const pick = list.find((c) => callNeedsYou(ctx, c)) ?? list.find((c) => c.status === "running") ?? list[list.length - 1];
      const done = list.filter((c) => c.status === "completed").length;
      const source = phase.sourceNodeId ? ctx.nodeMap.get(phase.sourceNodeId) : undefined;
      const state = s.callState(phase);
      const tag = phase.foreach
        ? (ctx.snapshot && list.length ? `已完成 ${done} / ${list.length}` : "逐项进行")
        : list.length > 1 ? `第 ${list.length} 次` : "";
      steps.push({
        key: phase.id,
        phaseId,
        label: source?.label ?? child.label,
        does: source?.steps.join(" · ") ?? "",
        state,
        attention: list.some((c) => callNeedsYou(ctx, c)),
        confirm,
        child: { frame: { flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: pick?.id }, tag },
        callPath,
      });
      continue;
    }
    for (const site of phase.run) {
      const node = ctx.nodeMap.get(site);
      if (!node) continue;
      const status = s.siteState(site, phaseId);
      const record = s.latest(site, phaseId);
      const gated = !!record && gates.some((gate) => gate.phase === phaseId);
      steps.push({
        key: `${phase.id}/${site}`,
        phaseId,
        site,
        node,
        label: node.label,
        does: node.steps.join(" · "),
        state: s.actionState(phase, status),
        attention: status.awaiting || gated,
        status,
        record,
        confirm,
        callPath,
      });
    }
  }
  return steps;
}

/** 子流程那一层的步骤：执行实例链往下接一层。 */
export function childSteps(ctx: FlowContext, step: FlowStep): FlowStep[] {
  if (!step.child) return [];
  const path = step.child.frame.instanceId ? [...step.callPath, step.child.frame.instanceId] : [...step.callPath];
  return frameSteps(ctx, step.child.frame, path);
}

const STAGE_WORD: Partial<Record<NodeState, string>> = { done: "已完成", "done-findings": "已完成", skipped: "已跳过", pending: "未开始", running: "进行中" };

/** 根层按阶段分组。 */
export function flowStages(ctx: FlowContext, entry: string, stages: readonly WorkflowStage[], rootLabel: string): FlowStageView[] {
  const frame: FlowFrame = { flow: ctx.structure.rootFlow, entry };
  const steps = frameSteps(ctx, frame);
  const flow = ctx.structure.flows[ctx.structure.rootFlow];
  const stageOfPhase = new Map((flow?.phases ?? []).map((p) => [p.id, p.stage ?? null]));
  const declared = new Set(stages.map((stage) => stage.id));
  const groups = stages.length === 0
    ? [{ id: "$all", label: rootLabel, steps }]
    : [
      ...stages.map((stage) => ({ id: stage.id, label: stage.label, steps: steps.filter((step) => stageOfPhase.get(step.phaseId) === stage.id) })),
      { id: "$other", label: "其他", steps: steps.filter((step) => { const id = stageOfPhase.get(step.phaseId); return !id || !declared.has(id); }) },
    ].filter((group) => group.steps.length > 0);
  const started = groups.map((group) => group.steps.some((step) => step.state !== "pending"));
  return groups.map((group, index) => {
    const states = group.steps.map((step) => step.state);
    const merged = mergeStates(states);
    // 部分完成、其余还没开始：后面的阶段已经开始，说明这一阶段走完了（没走到的是没被需要的分支）；
    // 否则这一阶段在进行中（mergeStates 报「未触发」是为单步写的）。
    const passed = started.slice(index + 1).some(Boolean);
    const state: NodeState = merged === "pending" && states.some(isSettled) && ctx.snapshot ? (passed ? "done" : "running") : merged;
    const attention = group.steps.some((step) => step.attention);
    const word = !ctx.snapshot ? `${group.steps.length} 步`
      : attention ? "要你处理"
        : STAGE_WORD[state] ?? STATE_LABEL[state];
    return { id: group.id, no: String(index + 1), label: group.label, state, attention, word, steps: group.steps };
  });
}

/** 胶囊 / 状态条的颜色类别。 */
export function toneOf(step: Pick<FlowStep, "state" | "attention">): "done" | "running" | "wait" | "alert" {
  if (step.attention || step.state === "failed" || step.state === "blocked" || step.state === "stuck") return "alert";
  if (isSettled(step.state)) return "done";
  return step.state === "running" ? "running" : "wait";
}
