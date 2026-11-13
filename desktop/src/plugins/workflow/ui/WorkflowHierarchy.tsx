/**
 * 执行关系画布（ADR 024 §5 ④；移植自 commit 24877d9 的
 * src/ui/right-panel/WorkflowHierarchy.tsx，逻辑逐行保留）：
 * 只画执行协议供给的 phase、call 与 route（不发明工作）。
 *
 * 移植适配：结构/记录类型改用 types.ts 的共享形状（HierarchyStructure /
 * WorkflowCatalogNode / CanvasSnapshot——引擎 run-detail 的宽容解析见
 * status/snapshot.ts）；`snapshot.run.result` 与节点 result 由 unknown 收窄
 * 后使用。节点状态文案（含 D8：落定运行的 findings/revise 不再标待办）。
 */
import { useMemo, useState } from "react";
import type {
  CanvasNodeSnapshot,
  CanvasSnapshot,
  HierarchyFlowDefinition,
  HierarchyFlowPhase,
  HierarchyFlowRoute,
  HierarchyStructure,
  WorkflowCatalogNode,
} from "../types.ts";
import { nodeStatus } from "../status/snapshot.ts";

type Frame = { flow: string; entry: string; via?: string; instanceId?: string };
type Positioned = { id: string; phase?: HierarchyFlowPhase; x: number; y: number; terminal?: boolean };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

/** Draw only phases, calls and routes supplied by the execution protocol. */
export function WorkflowHierarchy({ entry, structure, nodes, snapshot, selected, selectedPhase, focusOrdinal, runningSite, onSelect }: {
  entry: string;
  structure: HierarchyStructure;
  nodes: readonly WorkflowCatalogNode[];
  snapshot: CanvasSnapshot | null;
  selected: string;
  selectedPhase?: string;
  focusOrdinal?: number;
  runningSite?: string;
  onSelect: (site: string, callPath: string[], phaseId?: string) => void;
}) {
  const root: Frame = { flow: structure.rootFlow, entry };
  const [path, setPath] = useState<Frame[]>([root]);
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
  const graph = useMemo(() => expanded ? layout(expanded.flow, expanded.entry) : { items: [], edges: [], width: 800, height: 240 }, [expanded]);
  if (!flow) return <div className="workflow-empty">流程定义缺少当前子流程。</div>;
  const runResult = snapshot?.run ? asRecord(snapshot.run.result) : null;
  const activePhases = new Set([snapshot?.execution?.phase, ...(snapshot?.execution?.stack ?? []).map((f) => f.phase)]);
  const isActiveInCurrent = !current.via || !!current.instanceId && !!snapshot?.execution?.calls.some((call) => call.id === current.instanceId && call.status === "running");
  const inCurrent = (record: CanvasNodeSnapshot) => !current.via || !!current.instanceId && !!record.callPath?.includes(current.instanceId);
  const instances = (phase: string, parent?: string) => (snapshot?.execution?.calls ?? []).filter((c) => c.phase === phase && c.parent === (parent ?? null));
  const siteState = (site: string, phaseId: string): string => {
    if (!snapshot) return "未运行";
    const record = snapshot.nodes.filter((n) => n.siteId === site && n.phaseId === phaseId && inCurrent(n)).sort((a, b) => b.ordinal - a.ordinal)[0];
    if (!record) return "未触发";
    return nodeStatus({ id: site }, { ...snapshot, nodes: [record] }).label;
  };
  const state = (phase: HierarchyFlowPhase): string => {
    if (!snapshot) return "未运行";
    if (phase.call) {
      const calls = current.via && !current.instanceId ? [] : instances(phase.id, current.instanceId);
      if (phase.sourceNodeId) {
        const lastCall = calls.reduce<CanvasExecutionCall | undefined>((latest, call) => !latest || call.ordinal > latest.ordinal ? call : latest, undefined);
        const record = snapshot.nodes.filter((n) => n.siteId === phase.sourceNodeId && n.phaseId === (phase.sourcePhaseId ?? phase.id) && inCurrent(n)).sort((a, b) => b.ordinal - a.ordinal)[0];
        if (record?.status === "skipped" && (!lastCall || record.ordinal > lastCall.ordinal)) return "已跳过";
        if (!lastCall) return "未触发";
        if (lastCall.status === "failed") return "失败";
        if (lastCall.status === "running") return snapshot.active ? "运行中" : "结果待核验";
        return lastCall.status === "completed" ? "已完成" : "有执行记录";
      }
      if (!calls.length) return "未触发";
      if (calls.some((c) => c.status === "failed")) return "失败";
      if (calls.some((c) => c.status === "running")) return snapshot.active ? "运行中" : runResult !== null && runResult?.status === "blocked" ? "已阻塞" : "结果待核验";
      if (calls.some((c) => c.status === "pending")) return "等待中";
      return calls.every((c) => c.status === "completed") ? "已完成" : "有执行记录";
    }
    if (isActiveInCurrent && runResult?.status === "blocked" && runResult?.stage === phase.id) return "已阻塞";
    if (isActiveInCurrent && activePhases.has(phase.id)) return snapshot.active ? "运行中" : "已停止";
    if (!phase.call && phase.run.length === 1) return siteState(phase.run[0]!, phase.sourcePhaseId ?? phase.id);
    const sites = phase.run;
    const records = snapshot.nodes.filter((n) => sites.includes(n.siteId) && n.phaseId === phase.id && inCurrent(n));
    if (records.some((n) => n.status === "running")) return snapshot.active ? "运行中" : "结果待核验";
    return records.length ? "有执行记录" : "未触发";
  };
  return <div className="workflow-protocol-graph">
    <nav className="workflow-breadcrumb" aria-label="子流程路径">{path.map((frame, index) => <span key={`${frame.flow}:${frame.entry}:${index}`}>{index > 0 && <span aria-hidden="true"> / </span>}<button type="button" onClick={() => setPath(path.slice(0, index + 1))}>{structure.flows[frame.flow]?.label ?? frame.flow}</button></span>)}</nav>
    {current.via && instances(current.via, path[path.length - 2]?.instanceId).length > 0 && <label className="workflow-instance-picker">执行实例 <select aria-label="执行实例" value={current.instanceId ?? ""} onChange={(event) => { setPath([...path.slice(0, -1), { ...current, instanceId: event.target.value }]); onSelect("", []); }}>{instances(current.via, path[path.length - 2]?.instanceId).map((call) => <option key={call.id} value={call.id}>第 {call.ordinal} 次 {Object.values(call.scope).filter(Boolean).join(" / ")}</option>)}</select></label>}
    <div className="workflow-graph-canvas" style={{ width: graph.width, height: graph.height }}>
      <svg className="workflow-graph-edges" width={graph.width} height={graph.height} aria-label="执行关系">{graph.edges.map((edge, index) => <g key={index} data-from={edge.from} data-to={edge.to}><path d={edge.path} /><path d={`M ${edge.endX - 7} ${edge.endY - 4} L ${edge.endX} ${edge.endY} L ${edge.endX - 7} ${edge.endY + 4}`} />{edge.label && <text x={edge.textX} y={edge.textY}>{edge.label}</text>}</g>)}</svg>
      {graph.items.map((item) => item.terminal ? <div key={item.id} className="workflow-graph-terminal" style={{ left: item.x, top: item.y }}>{terminalLabel(item.id)}</div> : item.phase && (() => {
        if (item.phase.connector) return <div key={item.id} className="workflow-graph-terminal" style={{ left: item.x, top: item.y }}>并行起点</div>;
        const phase = item.phase;
        const child = phase.call ? structure.flows[phase.call] : undefined;
        const status = state(phase);
        const calls = child && (current.via && !current.instanceId ? [] : instances(phase.id, current.instanceId)) || [];
        const label = (phase.sourceNodeId ? nodeMap.get(phase.sourceNodeId)?.label : undefined) ?? child?.label ?? (phase.connector ? "并行起点" : phase.run.length === 1 ? nodeMap.get(phase.run[0]!)?.label : phase.run.length > 1 ? "并行执行" : phase.id) ?? phase.id;
        return <section key={item.id} className={`workflow-graph-phase ${status === "运行中" ? "running" : ""}`} style={{ left: item.x, top: item.y }} aria-label={label}>
          <div className="workflow-graph-phase-head"><b>{label}</b><span>{status}</span></div>
          {child ? <button className="workflow-graph-call" type="button" onClick={() => { const call = calls.find((c) => c.status === "running") ?? calls[calls.length - 1]; setPath([...path, { flow: child.id, entry: phase.callEntry || child.entry, via: phase.id, instanceId: call?.id }]); }}><span>进入子流程 ›</span>{phase.foreach && calls.length > 0 && <small>已完成 {calls.filter((c) => c.status === "completed").length} / {calls.length}</small>}</button> :
            <div className="workflow-graph-actions">{phase.run.map((site) => {
              const node = nodeMap.get(site);
              if (!node) return null;
              const phaseId = phase.sourcePhaseId ?? phase.id;
              const statusLabel = siteState(site, phaseId);
              const focusedPhase = selectedPhase ?? (focusOrdinal !== undefined ? targetRecord?.phaseId : undefined);
              return <button type="button" key={site} aria-label={`${node.label}，${statusLabel}`} className={selected === site && (!focusedPhase || focusedPhase === phaseId) ? "selected" : ""} onClick={() => onSelect(site, path.flatMap((frame) => frame.instanceId ? [frame.instanceId] : []), phaseId)}><span>{phase.run.length === 1 ? "查看动作与会话" : node.label}</span><small>{statusLabel}</small></button>;
            })}</div>}
        </section>;
      })())}
    </div>
  </div>;
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
          label: [edge.label ?? (edge.when !== undefined && edge.when !== null ? "条件" : ""), edge.optional ? "允许跳过" : ""].filter(Boolean).join(" · "),
        }))
        : targets(phase.routes);
      const node = nodeMap.get(site);
      phases.push({
        id: ids(phase)[index]!,
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

function layout(flow: HierarchyFlowDefinition, entry: string) {
  const phases = reachable(flow, entry);
  const map = new Map(phases.map((p) => [p.id, p]));
  // Collapse real cycles first, then assign each acyclic branch enough space
  // for its longest predecessor. A shorter branch must not place a join
  // before a longer branch that the join also depends on.
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
  const items: Positioned[] = [];
  const rows = new Map<number, number>();
  for (const p of phases) {
    const rank = ranks.get(p.id) ?? 0;
    const row = rows.get(rank) ?? 0;
    rows.set(rank, row + 1);
    items.push({ id: p.id, phase: p, x: 30 + rank * 250, y: 60 + row * 150 });
  }
  const terminals = [...new Set(phases.flatMap((p) => p.routes.map((r) => r.next).filter((n) => n.startsWith("$"))))];
  const last = Math.max(0, ...ranks.values()) + 1;
  terminals.forEach((id, index) => items.push({ id, terminal: true, x: 30 + last * 250, y: 60 + index * 150 }));
  const pos = new Map(items.map((i) => [i.id, i]));
  const edges = phases.flatMap((p) => p.routes.flatMap((r) => {
    const a = pos.get(p.id);
    const b = pos.get(r.next);
    if (!a || !b) return [];
    const sx = a.x + 205;
    const sy = a.y + 45;
    const ex = b.x;
    const ey = b.y + 45;
    const back = ex <= sx;
    const mid = (sx + ex) / 2;
    return [{
      from: p.id,
      to: r.next,
      path: back
        ? `M ${sx} ${sy} C ${sx + 25} ${sy}, ${sx + 25} 20, ${sx} 20 L ${ex - 25} 20 C ${ex - 45} 20, ${ex - 45} ${ey}, ${ex} ${ey}`
        : `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${ex} ${ey}`,
      endX: ex,
      endY: ey,
      textX: back ? Math.min(sx, ex) : mid,
      textY: back ? 16 : (sy + ey) / 2 - 5,
      label: r.label || (r.conditional ? "条件" : r.fallback ? "其他情况" : ""),
    }];
  }));
  return { items, edges, width: Math.max(800, 30 + (last + 1) * 250), height: Math.max(260, ...items.map((i) => i.y + 140)) };
}
