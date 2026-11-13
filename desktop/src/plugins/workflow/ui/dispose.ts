/**
 * 处置（ADR 031）的纯逻辑：一条节点记录能做哪些处置、改道能去哪些步骤。
 */
import type { CanvasNodeSnapshot, CanvasSnapshot, WorkflowCatalog } from "../types.ts";

export type DisposeAction = "rerun" | "rewind" | "goto" | "accept";

/** Agent 已提交、流程尚未接受的候选结果。 */
export interface DisposeCandidate {
  readonly id: string;
  readonly result: unknown;
}

/** 同一流程里可以改去的步骤（用节点或子流程的显示名）。 */
export function gotoTargets(catalog: WorkflowCatalog | null, phase: string): { id: string; label: string }[] {
  const flows = catalog?.structure?.flows ?? {};
  const flow = Object.values(flows).find((item) => item.phases.some((p) => p.id === phase));
  if (!flow) return [];
  const label = (id: string) => catalog?.nodes.find((node) => node.id === id)?.label ?? id;
  return flow.phases
    .filter((p) => !p.connector && p.id !== phase)
    .map((p) => ({
      id: p.id,
      label: p.call ? flows[p.call]?.label ?? p.id : p.run.map(label).join("、") || p.id,
    }));
}

/** 这条记录能做哪些处置。 */
export function disposeActions(snapshot: CanvasSnapshot | null, record: CanvasNodeSnapshot | undefined, candidates: number): DisposeAction[] {
  if (!snapshot || !record || record.mark === "superseded") return [];
  const checkpoint = snapshot.checkpoints?.find((item) => item.seq === record.checkpoint);
  const actions: DisposeAction[] = [];
  if (checkpoint?.available && checkpoint.current) actions.push("rerun", "goto");
  else if (checkpoint?.available) actions.push("rewind");
  if (candidates > 0 && (record.status === "running" || record.status === "failed")) actions.push("accept");
  return actions;
}
