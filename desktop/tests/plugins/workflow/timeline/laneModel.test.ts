import type { AawStepView } from "../../../../src/plugins/workflow/types.ts";
/**
 * 泳道派生测试：ar-clarify 边界切分（SR 主线 + 每 AR 一段）、同列多实例
 * 聚合（any running / all done）、任务簇（task-dev 给出簇内灯数组）、
 * 分叉（拆分列 → 各 AR 首列）、无 plan 回落步骤类型序。
 */
import { describe, expect, it } from "vitest";

import { buildLaneBoard } from "../../../../src/plugins/workflow/ui/timeline/laneModel.ts";

let seq = 0;
function step(
  type: string,
  status: AawStepView["executionStatus"],
): AawStepView {
  seq += 1;
  return {
    id: seq,
    type,
    name: type,
    execution: "skill",
    finished: status === "completed",
    executionStatus: status,
    isGate: type.endsWith("-gate"),
  };
}

const PLAN = {
  entry: "sr",
  nodes: [
    { id: "sr-init", name: "sr-init", kind: "direct" as const, isGate: false },
    {
      id: "sr-design-gate",
      name: "sr-design-gate",
      kind: "choice" as const,
      isGate: true,
    },
    {
      id: "ar-split",
      name: "ar-split",
      kind: "choice" as const,
      isGate: false,
    },
    {
      id: "ar-clarify",
      name: "ar-clarify",
      kind: "direct" as const,
      isGate: false,
    },
    {
      id: "module-boundary-design",
      name: "module-boundary-design",
      kind: "direct" as const,
      isGate: false,
    },
    {
      id: "task-dev",
      name: "task-dev",
      kind: "foreach" as const,
      isGate: false,
    },
  ],
  edges: [],
};

describe("buildLaneBoard", () => {
  it("ar-clarify 切分泳道：SR 主线 + 每条 AR 一段", () => {
    const board = buildLaneBoard(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [
          step("sr-init", "completed"),
          step("ar-split", "completed"),
          // AR-001
          step("ar-clarify", "completed"),
          step("task-dev", "completed"),
          // AR-002
          step("ar-clarify", "completed"),
          step("task-dev", "running"),
        ],
      },
      PLAN,
    );
    expect(board.lanes.map((lane) => lane.name)).toEqual([
      "SR 主线",
      "AR-001",
      "AR-002",
    ]);
    // 分叉：拆分列 → 两条 AR 首列（都是澄清列）
    expect(board.fork).not.toBeNull();
    expect(board.fork?.fromCol).toBe(
      board.columns.findIndex((col) => col.id === "ar-split"),
    );
    expect(board.fork?.toCols).toHaveLength(2);
    expect(new Set(board.fork?.toCols).size).toBe(1);
  });

  it("任务簇：task-dev 列给簇内灯数组（2 done + 1 running）", () => {
    const board = buildLaneBoard(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [
          step("ar-split", "completed"),
          step("ar-clarify", "completed"),
          step("task-dev", "completed"),
          step("task-dev", "completed"),
          step("task-dev", "running"),
        ],
      },
      PLAN,
    );
    const arLane = board.lanes[1] as NonNullable<(typeof board.lanes)[number]>;
    const clusterCell = arLane.cells.find((cell) => cell.cluster !== undefined);
    expect(clusterCell?.cluster).toEqual(["done", "done", "running"]);
    expect(clusterCell?.count).toBe(3);
  });

  it("未拆分（无第二条 ar-clarify）时单泳道、无分叉", () => {
    const board = buildLaneBoard(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [step("sr-init", "running")],
      },
      PLAN,
    );
    expect(board.lanes).toHaveLength(1);
    expect(board.lanes[0]?.name).toBe("SR 主线");
    expect(board.fork).toBeNull();
    // 全貌：SR 前缀的未到站补成 pending（启动 running + 门禁/拆分空环）
    const srLane = board.lanes[0] as NonNullable<(typeof board.lanes)[number]>;
    expect(srLane.cells.map((cell) => [cell.col, cell.lamp])).toEqual([
      [0, "running"],
      [1, "pending"],
      [2, "pending"],
    ]);
    // 迷你进度走站口径（与列头一致），不再是物化步数
    expect(srLane.done).toBe(0);
    expect(srLane.total).toBe(3);
    // 幽灵延展：拆分列 → 最后一个 AR 列（提示拆分后展开）
    expect(board.ghost).toEqual({
      fromCol: board.columns.findIndex((col) => col.id === "ar-split"),
      toCol: board.columns.findIndex((col) => col.id === "task-dev"),
    });
  });

  it("AR 泳道补模板后缀 pending 站（每条 AR 走同一条模板路径）", () => {
    const board = buildLaneBoard(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [
          step("sr-init", "completed"),
          step("ar-split", "completed"),
          step("ar-clarify", "completed"),
          step("task-dev", "running"),
        ],
      },
      PLAN,
    );
    const arLane = board.lanes[1] as NonNullable<(typeof board.lanes)[number]>;
    // ar-clarify(done) + module-boundary-design(pending) + task-dev(running)
    expect(arLane.cells.map((cell) => [cell.col, cell.lamp])).toEqual([
      [3, "done"],
      [4, "pending"],
      [5, "running"],
    ]);
    // 有 AR 泳道时不再需要幽灵延展
    expect(board.ghost).toBeNull();
  });

  it("无 plan 时列回落步骤类型首现序（无 pending 补全、无 ghost）", () => {
    const board = buildLaneBoard(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [step("sr-init", "completed"), step("ar-split", "completed")],
      },
      null,
    );
    expect(board.columns.map((col) => col.id)).toEqual(["sr-init", "ar-split"]);
  });
});
