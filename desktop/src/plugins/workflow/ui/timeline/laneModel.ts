import type { AawPlanPayload, AawStepView, AawWorkflowStatus } from "../../../../contracts/workflowModel.ts";
/**
 * 泳道派生（纯函数）：把工作流状态 + plan 拓扑投影成「泳道」结构——
 *
 * - **列**：plan 节点序（无 plan 时回落步骤类型首现序）；标签走
 *   stationNames 中文短名；
 * - **泳道切分**：`ar-clarify` 是每条 AR 的首站（foreach 展开后的入口），
 *   以它为界把有序步骤流切成「SR 主线（含拆分前）+ 每条 AR 一段」；
 *   同泳道内步骤按列聚合，多实例（多任务）再聚成一盏灯/一簇；
 * - **任务簇**：task-dev 列的多个实例不聚合灯，而是给出簇内各实例的
 *   灯色数组（pill 并排画）——并行任务的差异一目了然；
 * - **分叉**：SR 泳道的拆分列 → 各 AR 泳道的首个物化列（渲染成
 *   git 分支曲线）；无 AR 泳道时为 null；
 * - 已知取舍：步骤数据不携带 AR 身份（type 复用模板名），切分依赖
 *   ar-clarify 边界标记——对当前 v3 拓扑成立；定义大改时此处需同步。
 */
import type { TimelineLamp } from "./aawTimelineModel.ts";
import { stationDisplayName } from "./stationNames.ts";

export interface LaneColumn {
  readonly id: string;
  readonly label: string;
  readonly isGate: boolean;
}

export type LaneDot = "done" | "running" | "failed";

export interface LaneCell {
  readonly col: number;
  readonly lamp: TimelineLamp;
  /** 聚合实例数（>1 时 UI 出 ×N）。 */
  readonly count: number;
  /** 门禁列（渲染成菱形）。 */
  readonly isGate: boolean;
  /** 任务簇列：簇内各实例灯色（渲染成并排小灯）。 */
  readonly cluster?: readonly TimelineLamp[];
}

export interface WorkflowLane {
  readonly id: string;
  readonly name: string;
  readonly dot: LaneDot;
  /** 已完成站数 / 总站数（迷你进度条；口径 = 泳道上的站，含未到的）。 */
  readonly done: number;
  readonly total: number;
  /** 泳道内出现过的列（渲染轨的范围）。 */
  readonly cells: readonly LaneCell[];
}

export interface LaneBoardModel {
  readonly columns: readonly LaneColumn[];
  readonly lanes: readonly WorkflowLane[];
  /** 分叉：SR 泳道拆分列 → 各 AR 首列。null = 没有派生 AR。 */
  readonly fork: {
    readonly fromCol: number;
    readonly toCols: readonly number[];
  } | null;
  /**
   * 幽灵延展区：尚未拆分且 plan 有拆分后节点时，SR 泳道从拆分列到
   * 最后一个 AR 列画虚线 + 提示（「拆分后在此展开」）——否则右侧列头
   * 下整片空白，读起来像渲染坏了。
   */
  readonly ghost: {
    readonly fromCol: number;
    readonly toCol: number;
  } | null;
}

function lampOf(step: AawStepView): TimelineLamp {
  switch (step.executionStatus) {
    case "running":
      return "running";
    case "failed":
    case "blocked":
      return "failed";
    case "superseded":
      return "superseded";
    default:
      return step.finished ? "done" : "pending";
  }
}

function dotOf(lamps: readonly TimelineLamp[]): LaneDot {
  if (lamps.includes("failed")) {
    return "failed";
  }
  if (lamps.includes("running")) {
    return "running";
  }
  return "done";
}

function isGateId(id: string): boolean {
  return id.endsWith("-gate");
}

/** 列序：plan 节点优先（完整拓扑），缺失时回落步骤类型首现序。 */
function deriveColumns(
  steps: readonly AawStepView[],
  plan: AawPlanPayload | null | undefined,
): LaneColumn[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  if (plan !== null && plan !== undefined) {
    for (const node of plan.nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        ids.push(node.id);
      }
    }
  }
  for (const step of [...steps].sort((a, b) => a.id - b.id)) {
    if (!seen.has(step.type)) {
      seen.add(step.type);
      ids.push(step.type);
    }
  }
  return ids.map((id) => ({
    id,
    label: stationDisplayName(id),
    isGate: isGateId(id),
  }));
}

/** 以 ar-clarify 为界切泳道：[SR 主线(含拆分), AR 段…] */
function segmentLanes(steps: readonly AawStepView[]): AawStepView[][] {
  const segments: AawStepView[][] = [];
  let current: AawStepView[] = [];
  let sawSplit = false;
  for (const step of steps) {
    if (step.type === "ar-clarify") {
      if (current.length > 0) {
        segments.push(current);
      }
      current = [step];
      sawSplit = true;
      continue;
    }
    current.push(step);
  }
  if (current.length > 0) {
    segments.push(current);
  }
  // 没有任何 ar-clarify（未拆分/未到拆分）：全部归 SR 主线一段
  if (!sawSplit && segments.length > 1) {
    return [[...steps]];
  }
  return segments;
}

/**
 * 把 plan 拓扑里「该泳道还没走到」的节点补成 pending 站——地铁图的
 * 承诺是全貌：刚启动的 SR 也要能看到 详设→门禁→拆分 一整条线，而不是
 * 一颗孤灯浮在空泳道上。SR 泳道补拆分前缀，AR 泳道补 ar-clarify 起
 * 的模板后缀（每条 AR 走的是同一条模板路径）。
 */
function withPendingCells(
  cells: readonly LaneCell[],
  types: readonly string[],
  colIndex: ReadonlyMap<string, number>,
  columns: readonly LaneColumn[],
): LaneCell[] {
  const seen = new Set(cells.map((cell) => cell.col));
  const extra: LaneCell[] = [];
  for (const type of types) {
    const col = colIndex.get(type);
    if (col === undefined || seen.has(col)) {
      continue;
    }
    seen.add(col);
    extra.push({
      col,
      lamp: "pending",
      count: 1,
      isGate: columns[col]?.isGate ?? false,
    });
  }
  return [...cells, ...extra].sort((a, b) => a.col - b.col);
}

export function buildLaneBoard(
  status: AawWorkflowStatus,
  plan: AawPlanPayload | null | undefined,
): LaneBoardModel {
  const steps = [...status.steps].sort((a, b) => a.id - b.id);
  const columns = deriveColumns(steps, plan);
  const colIndex = new Map(columns.map((col, i) => [col.id, i] as const));
  const segments = segmentLanes(steps);

  // plan 拓扑按 ar-clarify 切两段：SR 前缀（拆分前）/ AR 后缀（模板路径）
  const planNodes = plan?.nodes ?? [];
  const clarifyIdx = planNodes.findIndex((node) => node.id === "ar-clarify");
  const srPrefixTypes =
    clarifyIdx === -1
      ? planNodes.map((node) => node.id)
      : planNodes.slice(0, clarifyIdx).map((node) => node.id);
  const arSuffixTypes =
    clarifyIdx === -1 ? [] : planNodes.slice(clarifyIdx).map((node) => node.id);

  const lanes: WorkflowLane[] = segments.map((segment, si) => {
    const lampsByCol = new Map<number, TimelineLamp[]>();
    for (const step of segment) {
      const col = colIndex.get(step.type);
      if (col === undefined) {
        continue;
      }
      const list = lampsByCol.get(col) ?? [];
      list.push(lampOf(step));
      lampsByCol.set(col, list);
    }
    const materialized: LaneCell[] = [...lampsByCol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, lamps]) => {
        const column = columns[col];
        return {
          col,
          lamp: dotOf(lamps),
          count: lamps.length,
          isGate: column?.isGate ?? false,
          cluster: column?.id === "task-dev" ? lamps : undefined,
        };
      });
    const cells = withPendingCells(
      materialized,
      si === 0 ? srPrefixTypes : arSuffixTypes,
      colIndex,
      columns,
    );
    const lamps = segment.map((step) => lampOf(step));
    const arNo = si;
    return {
      id: si === 0 ? "sr" : `ar-${arNo}`,
      name: si === 0 ? "SR 主线" : `AR-00${arNo}`,
      dot: dotOf(lamps),
      done: cells.filter(
        (cell) => cell.lamp === "done" || cell.lamp === "superseded",
      ).length,
      total: cells.length,
      cells,
    };
  });

  // 分叉：拆分列（ar-split）→ 各 AR 泳道首个物化列
  const arLanes = lanes.filter((_, i) => i > 0);
  const arSplitCol = colIndex.get("ar-split") ?? null;
  const fork =
    arLanes.length > 0 && arSplitCol !== null
      ? {
          fromCol: arSplitCol,
          toCols: arLanes.map((lane) => lane.cells[0]?.col ?? arSplitCol),
        }
      : null;

  // 幽灵延展：还没拆出 AR 时，从拆分列虚线延伸到最后一个 AR 列
  const suffixCols = arSuffixTypes
    .map((type) => colIndex.get(type))
    .filter((col): col is number => col !== undefined);
  const ghost =
    arLanes.length === 0 && arSplitCol !== null && suffixCols.length > 0
      ? { fromCol: arSplitCol, toCol: Math.max(...suffixCols) }
      : null;

  return { columns, lanes, fork, ghost };
}
