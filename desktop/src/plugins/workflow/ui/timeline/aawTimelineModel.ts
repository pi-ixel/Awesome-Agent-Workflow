import type { AawPlanPayload, AawStepView, AawWorkflowStatus } from "../../../../contracts/workflowModel.ts";
/**
 * AAW 时间线模型（纯函数）：把工作流投影成「地铁线」时间线的站序列——
 * 设计语言照搬 ZCode 的 WorkflowTimeline：一根横轨、站是轨道上的灯、
 * 运行中的站有心跳。这里是它的 AAW 化简版（AAW 主路径是线性序，没有
 * 并行带 / 子代理药丸 / 回边，因此只有轨 + 灯）。
 *
 * 站序列的来源有两层（`aaw status` 的 steps 只含**已物化**的步骤——门禁
 * 放行才生成后继，SR 刚创建时只有 1 步）：
 * - 有 `aaw plan`（定义拓扑全貌，唯一完整来源）时：站序 = plan 节点序，
 *   status 的已物化步骤按 type 匹配叠上执行灯，未物化的站画空环——
 *   完整的图 + 上面表达的进度；
 * - 无 plan（老 CLI / 解析失败）时回落仅 status 的旧口径。
 *
 * 灯色词汇表：done（绿实心）/ running（活动色 + 心跳）/ failed（红，含
 * blocked）/ superseded（灰淡）/ pending（空环）。
 */

/** 站灯状态（时间线渲染词汇表）。 */
export type TimelineLamp =
  "done" | "running" | "failed" | "superseded" | "pending";

/** 时间线上的一个站（= 流程图上的一个节点）。 */
export interface TimelineStation {
  /** 站标识（plan 节点 id / status step 的 type）。 */
  readonly stepId: string;
  readonly name: string;
  readonly type: string;
  readonly isGate: boolean;
  readonly lamp: TimelineLamp;
  /** 该站已在状态文件中物化（false = plan 里可见、尚未到达）。 */
  readonly materialized: boolean;
  /**
   * 该站已物化的实例数（foreach 拆分：ar-clarify 每条 AR 一个、task-dev
   * 每个任务一个）。>1 时 UI 给 ×N 徽标——灯是聚合语义，实例数说清
   * 「这条站上同时跑着几条」。
   */
  readonly instanceCount: number;
  /** 轨道段（本站与右邻站之间）是否「已走过」——strong 墨色。 */
  readonly railStrong: boolean;
}

export interface AawTimelineModel {
  readonly stations: readonly TimelineStation[];
  /** 镜头应对准的站（首个 running；无则首个未完成站）；null = 全部完成。 */
  readonly focusIndex: number | null;
  readonly doneCount: number;
  readonly totalCount: number;
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

/**
 * 同 type 多实例（多 AR / 多任务各自物化同名步骤）聚合成一盏灯：
 * 任一在跑 → running（这条站上还有活）；任一失败 → failed（优先于跑）；
 * 其余按「全部完成才算过站」——走得最远的实例不能替兄弟姐妹报捷。
 */
function aggregateLamp(steps: readonly AawStepView[]): TimelineLamp {
  const lamps = steps.map((step) => lampOf(step));
  if (lamps.includes("running")) {
    return "running";
  }
  if (lamps.includes("failed")) {
    return "failed";
  }
  if (lamps.includes("superseded")) {
    return "superseded";
  }
  return lamps.every((lamp) => lamp === "done") ? "done" : "pending";
}

function reachedLamp(lamp: TimelineLamp): boolean {
  return lamp !== "pending";
}

function isDoneLamp(lamp: TimelineLamp): boolean {
  return lamp === "done" || lamp === "superseded";
}

/** 给定站序列，补齐每站的轨段墨色（两端都走过的轨段 strong）。 */
function withRails(stations: TimelineStation[]): TimelineStation[] {
  return stations.map((station, index) => ({
    ...station,
    railStrong:
      index < stations.length - 1 &&
      reachedLamp(station.lamp) &&
      reachedLamp((stations[index + 1] as TimelineStation).lamp),
  }));
}

function resolveModel(stations: TimelineStation[]): AawTimelineModel {
  const focusIndex = stations.findIndex(
    (station) => station.lamp === "running",
  );
  const firstUndone = stations.findIndex(
    (station) => !isDoneLamp(station.lamp),
  );
  return {
    stations,
    focusIndex:
      focusIndex !== -1 ? focusIndex : firstUndone !== -1 ? firstUndone : null,
    doneCount: stations.filter((station) => isDoneLamp(station.lamp)).length,
    totalCount: stations.length,
  };
}

/** 仅按 status 步骤（旧口径，plan 不可用时的回落）。 */
function buildFromStatus(status: AawWorkflowStatus): AawTimelineModel {
  const steps = [...status.steps].sort((left, right) => left.id - right.id);
  const stations: TimelineStation[] = steps.map((step) => ({
    stepId: step.type,
    name: step.name,
    type: step.type,
    isGate: step.isGate,
    lamp: lampOf(step),
    materialized: true,
    instanceCount: 1,
    railStrong: false,
  }));
  return resolveModel(withRails(stations));
}

/**
 * plan 节点为完整站序，status 已物化步骤按 type 分组聚合叠灯：多 AR /
 * 多任务各自物化的同名步骤（ar-clarify ×3、task-dev ×N）聚合为一盏灯
 * （any running / any failed / all done 才算过站），instanceCount 记录
 * 实例数供 UI 出 ×N 徽标。status 里出现而 plan 没有的步骤（定义升级后
 * 的残留）聚合后追加在尾部，不丢事实。
 */
function buildFromPlan(
  status: AawWorkflowStatus,
  plan: AawPlanPayload,
): AawTimelineModel {
  const byType = new Map<string, AawStepView[]>();
  for (const step of status.steps) {
    const group = byType.get(step.type);
    if (group === undefined) {
      byType.set(step.type, [step]);
    } else {
      group.push(step);
    }
  }
  const matched = new Set<string>();
  const stations: TimelineStation[] = plan.nodes.map((node) => {
    const instances = byType.get(node.id) ?? [];
    if (instances.length > 0) {
      matched.add(node.id);
    }
    return {
      stepId: node.id,
      name: node.name,
      type: node.id,
      isGate: node.isGate,
      lamp: instances.length === 0 ? "pending" : aggregateLamp(instances),
      materialized: instances.length > 0,
      instanceCount: instances.length,
      railStrong: false,
    };
  });
  for (const [type, instances] of byType) {
    if (!matched.has(type)) {
      const last = instances.at(-1) as AawStepView;
      stations.push({
        stepId: type,
        name: last.name,
        type,
        isGate: last.isGate,
        lamp: aggregateLamp(instances),
        materialized: true,
        instanceCount: instances.length,
        railStrong: false,
      });
    }
  }
  return resolveModel(withRails(stations));
}

export function buildAawTimeline(
  status: AawWorkflowStatus,
  plan?: AawPlanPayload | null,
): AawTimelineModel {
  if (plan !== null && plan !== undefined && plan.nodes.length > 0) {
    return buildFromPlan(status, plan);
  }
  return buildFromStatus(status);
}
