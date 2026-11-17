/**
 * 画布的层级路径（下钻 / 返回 / 跳到任意层）与子流程树。
 *
 * 从前这一整块嵌在 WorkflowHierarchy 里：下钻靠组件内部的 path 栈，右上角的
 * 流程导航够不着它，只能自己再算一遍层级。现在路径是一份由 hook 持有的状态，
 * 画布和导航共用同一份 —— 导航里点哪一层，画布就换到哪一层。
 */
import { useMemo, useState } from "react";
import type {
  CanvasSnapshot,
  HierarchyFlowDefinition,
  HierarchyFlowPhase,
  HierarchyFlowRoute,
  HierarchyStructure,
  WorkflowCatalogNode,
} from "../types.ts";

/** 当前看的是哪一层：哪条流程、从哪个入口进、由哪一步调用进来、哪一次执行实例。 */
export interface Frame {
  readonly flow: string;
  readonly entry: string;
  /** 调用它的那一步（根层没有）。 */
  readonly via?: string;
  readonly instanceId?: string;
}

/** 自动跟随的目标节点（运行中的节点或被选中的节点）。 */
export interface PathTarget {
  readonly site: string;
  readonly phaseId?: string;
  readonly callPath?: readonly string[];
}

/**
 * 展开可执行节点的依赖：一个 phase 里带 edges 的多个动作要拆成各自的格子，
 * 否则连线无处可落。不发明工作，只把已有的 phase.run 摊开。
 */
export function expandDependencies(
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
 * 这一层有几个步骤（卡片数），给子流程脚上的「子工作流 · N 步」。
 * 一次子流程调用也是一步（`run` 为空、只有 `call` 的 phase 算 1 步）。
 */
export function flowStepCount(flow: HierarchyFlowDefinition | undefined): number {
  return flow
    ? flow.phases.reduce((count, phase) => count + (phase.run.length > 0 ? phase.run.length : phase.call ? 1 : 0), 0)
    : 0;
}

/**
 * 从根层找到目标节点所在的那一层（含沿途每一层）：运行中的节点在子流程里时，
 * 画布自动换到那一层，而不是让用户自己找。找不到就保持当前层。
 */
export function findPath(options: {
  structure: HierarchyStructure;
  entry: string;
  nodeMap: Map<string, WorkflowCatalogNode>;
  target: PathTarget | null;
  snapshot: CanvasSnapshot | null;
}): Frame[] | null {
  const { structure, entry, nodeMap, target, snapshot } = options;
  if (!target) return null;
  const find = (frame: Frame, seen: Set<string>): Frame[] | null => {
    const key = `${frame.flow}:${frame.entry}`;
    if (seen.has(key)) return null;
    const flow = structure.flows[frame.flow];
    if (!flow) return null;
    const next = new Set(seen);
    next.add(key);
    const expanded = expandDependencies(flow, frame.entry, nodeMap);
    for (const phase of reachable(expanded.flow, expanded.entry)) {
      if (phase.run.includes(target.site) && (!target.phaseId || target.phaseId === (phase.sourcePhaseId ?? phase.id))) return [frame];
      if (phase.call) {
        const child = structure.flows[phase.call];
        if (child) {
          const matches = (snapshot?.execution?.calls ?? []).filter((c) => c.phase === phase.id && c.parent === (frame.instanceId ?? null));
          const instance = matches.find((c) => target.callPath?.includes(c.id)) ?? matches.find((c) => c.status === "running") ?? matches[matches.length - 1];
          const result = find({ flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: instance?.id }, next);
          if (result) return [frame, ...result];
        }
      }
    }
    return null;
  };
  return find({ flow: structure.rootFlow, entry }, new Set());
}

/** 某一层里每个可调用子流程的落点（导航树与「跳层」共用）。 */
export interface FlowTreeStep {
  readonly flow: string;
  readonly label: string;
  readonly entry: string;
  /** 调用它的 phase id（根层为 undefined）。 */
  readonly via?: string;
  readonly stepCount: number;
  readonly children: readonly FlowTreeStep[];
}

/** 子流程树：从根层往下把所有能进去的层铺平，最深的一层也能一键跳过去。 */
export function flowTree(structure: HierarchyStructure, entry: string, nodeMap?: Map<string, WorkflowCatalogNode>): FlowTreeStep[] {
  const build = (flowId: string, flowEntry: string, seen: ReadonlySet<string>): FlowTreeStep => {
    const flow = structure.flows[flowId];
    const label = flow?.label ?? flowId;
    const next = new Set(seen).add(flowId);
    const children: FlowTreeStep[] = [];
    if (flow) {
      const expanded = nodeMap ? expandDependencies(flow, flowEntry, nodeMap) : { flow, entry: flowEntry };
      for (const phase of reachable(expanded.flow, expanded.entry)) {
        const childFlow = phase.call ? structure.flows[phase.call] : undefined;
        if (!childFlow || next.has(childFlow.id)) continue;
        if (children.some((item) => item.flow === childFlow.id)) continue;
        const child = build(childFlow.id, childFlow.entry, next);
        children.push({ ...child, via: phase.id });
      }
    }
    return { flow: flowId, label, entry: flowEntry, stepCount: flowStepCount(flow), children };
  };
  return [build(structure.rootFlow, entry, new Set())];
}

/** 按给定的层链算出 path（导航里点某一层时用）：每层带上最近一次执行实例。 */
export function framesOf(options: {
  entry: string;
  chain: readonly FlowTreeStep[];
  snapshot: CanvasSnapshot | null;
}): Frame[] {
  const { entry, chain, snapshot } = options;
  const frames: Frame[] = [];
  chain.forEach((step, index) => {
    if (index === 0) {
      frames.push({ flow: step.flow, entry: index === 0 ? entry : step.entry });
      return;
    }
    const parent = frames[frames.length - 1]!;
    const calls = (snapshot?.execution?.calls ?? []).filter((call) => call.phase === step.via && call.parent === (parent.instanceId ?? null));
    const instance = calls.find((call) => call.status === "running") ?? calls[calls.length - 1];
    frames.push({ flow: step.flow, entry: step.entry, via: step.via, instanceId: instance?.id });
  });
  return frames;
}

/** 进入一层：把新 frame 压到栈顶。 */
export function pushFrame(path: readonly Frame[], frame: Frame): Frame[] {
  return [...path, frame];
}

/**
 * 回到上一层。返回要重新聚焦的子流程卡（调用它的 phase id）：键盘返回时
 * 焦点落回进入时那张卡，鼠标点击不抢焦点由调用方决定。
 */
export function popFrame(path: readonly Frame[]): { path: Frame[]; focus: string } | null {
  if (path.length < 2) return null;
  const current = path[path.length - 1]!;
  return { path: path.slice(0, -1), focus: current.via ?? "" };
}

/** 跳到第 index 层（0 = 根层）。同样返回被关掉那一层的子流程卡。 */
export function jumpFrame(path: readonly Frame[], index: number): { path: Frame[]; focus: string } | null {
  if (index < 0 || index >= path.length - 1) return null;
  return { path: path.slice(0, index + 1), focus: path[index + 1]?.via ?? "" };
}

/**
 * 层级路径状态：当前层，以及「运行到别的层时自动跟过去」。
 * 进 / 出 / 跳层的换算在上面三个纯函数里，导航与画布共用同一份 path。
 */
export function useFlowPath(options: {
  structure: HierarchyStructure;
  entry: string;
  nodeMap: Map<string, WorkflowCatalogNode>;
  target: PathTarget | null;
  snapshot: CanvasSnapshot | null;
}) {
  const { structure, entry, nodeMap, target, snapshot } = options;
  const root = useMemo<Frame>(() => ({ flow: structure.rootFlow, entry }), [structure.rootFlow, entry]);
  const [path, setPath] = useState<Frame[]>([root]);
  const current = path[path.length - 1] ?? root;

  // 跟随：目标节点换到别的层时自动把画布切过去。只在「导航目标真的变了」
  // 时找一次（快照每 30 秒刷新一次，不该每次都铺一遍全图）；用户在子流程里
  // 手动翻页不会被下一次刷新抢回去。
  const targetKey = target ? `${target.site}:${target.phaseId ?? ""}:${target.callPath?.join("|") ?? ""}` : "";
  const navigationKey = target ? `${structure.rootFlow}:${entry}:${targetKey}` : "";
  const [lastNavigation, setLastNavigation] = useState("");
  if (navigationKey !== lastNavigation) {
    setLastNavigation(navigationKey);
    if (target) {
      const found = findPath({ structure, entry, nodeMap, target, snapshot });
      if (found) setPath(found);
    }
  }

  return { path, current, setPath };
}
