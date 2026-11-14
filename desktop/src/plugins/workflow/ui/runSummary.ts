/**
 * 运行总结（ADR 035，E4）：从快照算出概况、各节点做了什么和用了多久、节点声明的产出文件。
 * 只陈述引擎记录的事实：结论取自节点自己交的结果，不替节点下结论。本版不含代码变化。
 */
import type { CanvasSnapshot, WorkflowCatalogNode } from "../types.ts";
import { recordStatus, statusLabel } from "../status/snapshot.ts";
import { nodeTiming, runWaitedMs } from "../status/timing.ts";
import { describeResult, type Tone } from "./nodeDetail.ts";

export interface SummaryStep {
  readonly siteId: string;
  readonly ordinal: number;
  readonly callPath: readonly string[];
  readonly phaseId: string | null;
  readonly label: string;
  /** 同一节点的第几轮；只有一轮时为 null。 */
  readonly round: number | null;
  readonly status: string;
  readonly conclusion?: { readonly text: string; readonly tone: Tone };
  readonly elapsedMs: number | null;
  readonly waitedMs: number;
}

export interface SummaryFile {
  readonly label: string;
  readonly path: string;
  /** 产出它的节点。 */
  readonly from: string;
}

export interface RunSummaryView {
  readonly title: string;
  readonly status: string;
  readonly startedAt: number | null;
  /** 运行停下的时刻；还在跑时为 null。 */
  readonly endedAt: number | null;
  readonly elapsedMs: number | null;
  readonly waitedMs: number;
  /** 回退、重跑与改道的次数。 */
  readonly reworks: number;
  /** 放行确认关卡的次数。 */
  readonly confirms: number;
  /** 因回退作废的节点轮次数。 */
  readonly superseded: number;
  readonly steps: readonly SummaryStep[];
  readonly files: readonly SummaryFile[];
}

export function summarizeRun(snapshot: CanvasSnapshot, now: number): RunSummaryView | null {
  const run = snapshot.run;
  if (!run) return null;
  const catalogNodes = new Map<string, WorkflowCatalogNode>((snapshot.catalog?.nodes ?? []).map((node) => [node.id, node]));
  // 子流程调用本身没有可读的结果，总结里只列真正干活的节点。
  const records = snapshot.nodes.filter((record) => record.kind !== "flow" && catalogNodes.get(record.siteId)?.kind !== "flow");
  const live = records.filter((record) => record.mark !== "superseded");
  const rounds = new Map<string, number>();
  for (const record of live) rounds.set(record.siteId, (rounds.get(record.siteId) ?? 0) + 1);

  const steps: SummaryStep[] = live.map((record) => {
    const node = catalogNodes.get(record.siteId);
    const timing = nodeTiming(record, now);
    const conclusion = describeResult(record.result, node?.labels, snapshot.artifacts)?.conclusion;
    return {
      siteId: record.siteId,
      ordinal: record.ordinal,
      callPath: record.callPath,
      phaseId: record.phaseId ?? null,
      label: node?.label || record.siteId,
      round: (rounds.get(record.siteId) ?? 0) > 1 ? record.ordinal : null,
      status: recordStatus(record),
      ...(conclusion ? { conclusion } : {}),
      elapsedMs: timing?.elapsedMs ?? null,
      waitedMs: timing?.waitedMs ?? 0,
    };
  });

  // 每个节点取最新一轮交的文件；同一路径只列一次，记在最后产出它的节点下。
  const latest = new Map<string, (typeof live)[number]>();
  for (const record of live) {
    const key = `${record.siteId}\0${record.callPath.join("/")}`;
    const previous = latest.get(key);
    if (!previous || previous.ordinal <= record.ordinal) latest.set(key, record);
  }
  const files = new Map<string, SummaryFile>();
  for (const record of latest.values()) {
    const node = catalogNodes.get(record.siteId);
    for (const file of describeResult(record.result, node?.labels, snapshot.artifacts)?.files ?? []) {
      files.delete(file.path);
      files.set(file.path, { label: file.label, path: file.path, from: node?.label || record.siteId });
    }
  }

  const interventions = snapshot.interventions ?? [];
  const settled = !snapshot.active && run.status !== "running";
  const startedAt = run.createdAt ?? null;
  const endedAt = settled ? run.updatedAt ?? null : null;
  return {
    title: run.title || run.name || "工作流",
    status: statusLabel(run, snapshot.catalog),
    startedAt,
    endedAt,
    elapsedMs: startedAt === null ? null : Math.max(0, (endedAt ?? now) - startedAt),
    waitedMs: runWaitedMs(records, now),
    reworks: interventions.filter((item) => item.kind === "rewind" || item.kind === "goto").length,
    confirms: interventions.filter((item) => item.kind === "confirm").length,
    superseded: records.length - live.length,
    steps,
    files: [...files.values()],
  };
}
