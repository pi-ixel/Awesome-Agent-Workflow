import { isSettled, mergeStates, nodeStatus, type NodeState } from "../status/snapshot.ts";
import type { CanvasSnapshot, WorkflowCatalog } from "../types.ts";

/**
 * 头部进度：每个阶段一段（定义没有阶段时不显示）。与画布条带同一判定：
 * 阶段内全部结束，或运行已走过它（后面的阶段已开始）且其中没有进行中 /
 * 待人处理的节点，才算结束——没被需要的条件节点（修正、整改）不拖住进度。
 */
export function progressStages(catalog: WorkflowCatalog | null, snapshot: CanvasSnapshot | null): { id: string; label: string; state: NodeState }[] {
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
