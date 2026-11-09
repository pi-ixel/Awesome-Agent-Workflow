import type { AawStepView } from "../../../../src/contracts/workflowModel.ts";
/**
 * AAW 时间线模型测试：六态灯映射（failed/blocked 归并为红灯、superseded
 * 灰淡、finished 绿实心、running 心跳位、pending 空环）、focusIndex 取
 * 首个 running（无则首个未完成）、doneCount 统计与轨段墨色（两端都走过
 * 才 strong）。另覆盖 deriveStepPhases 的坏终态可见性修复。
 */
import { describe, expect, it } from "vitest";

import { deriveStepPhases } from "../../../../src/shared/workflowStepPhases.ts";
import { buildAawTimeline } from "../../../../src/plugins/workflow/ui/timeline/aawTimelineModel.ts";

function step(overrides: Partial<AawStepView> & { id: number }): AawStepView {
  return {
    type: `step-${overrides.id}`,
    name: `步骤${overrides.id}`,
    execution: "skill",
    finished: false,
    executionStatus: null,
    isGate: false,
    ...overrides,
  };
}

describe("buildAawTimeline", () => {
  it("六态灯映射：done/running/failed(blocked)/superseded/pending", () => {
    const model = buildAawTimeline({
      sr: "SR-001",
      entry: "sr",
      status: "in_progress",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [
        step({ id: 1, finished: true }),
        step({ id: 2, executionStatus: "running" }),
        step({ id: 3, executionStatus: "failed" }),
        step({ id: 4, executionStatus: "blocked" }),
        step({ id: 5, executionStatus: "superseded" }),
        step({ id: 6 }),
      ],
    });
    expect(model.stations.map((station) => station.lamp)).toEqual([
      "done",
      "running",
      "failed",
      "failed",
      "superseded",
      "pending",
    ]);
    // focus = 首个 running；done 计数含 superseded（不再占待办位）
    expect(model.focusIndex).toBe(1);
    expect(model.doneCount).toBe(2);
  });

  it("多实例聚合：ar-clarify ×3（2 done 1 running）→ running 灯 + ×3 计数；全部 done 才算过站", () => {
    const step = (id: number, status: AawStepView["executionStatus"]) => ({
      id,
      type: `ar-clarify`,
      name: `ar-clarify`,
      execution: "skill",
      finished: status !== null && status !== "running",
      executionStatus: status,
      isGate: false,
    });
    const model = buildAawTimeline(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        // 三条 AR 各自物化了 ar-clarify：两条完成、一条在跑
        steps: [step(1, "completed"), step(2, "completed"), step(3, "running")],
      },
      {
        entry: "sr",
        nodes: [
          { id: "ar-split", name: "ar-split", kind: "choice", isGate: false },
          {
            id: "ar-clarify",
            name: "ar-clarify",
            kind: "direct",
            isGate: false,
          },
          { id: "task-dev", name: "task-dev", kind: "direct", isGate: false },
        ],
        edges: [],
      },
    );
    const clarify = model.stations.find((s) => s.stepId === "ar-clarify");
    expect(clarify?.lamp).toBe("running");
    expect(clarify?.instanceCount).toBe(3);
    // 反例：走得最远的实例不能替其余报捷——2 done + 1 未跑完 = 未过站
    const doneCase = buildAawTimeline(
      {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [step(1, "completed"), step(2, "completed")],
      },
      {
        entry: "sr",
        nodes: [
          { id: "ar-split", name: "ar-split", kind: "choice", isGate: false },
          {
            id: "ar-clarify",
            name: "ar-clarify",
            kind: "direct",
            isGate: false,
          },
        ],
        edges: [],
      },
    );
    expect(doneCase.stations.find((s) => s.stepId === "ar-clarify")?.lamp).toBe(
      "done",
    );
  });

  it("无 running 时 focus 落在首个未完成站；全部完成为 null", () => {
    const model = buildAawTimeline({
      sr: "SR-001",
      entry: "sr",
      status: "in_progress",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [
        step({ id: 1, finished: true }),
        step({ id: 2 }),
        step({ id: 3 }),
      ],
    });
    expect(model.focusIndex).toBe(1);
    const done = buildAawTimeline({
      sr: "SR-001",
      entry: "sr",
      status: "done",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [step({ id: 1, finished: true }), step({ id: 2, finished: true })],
    });
    expect(done.focusIndex).toBeNull();
  });

  it("轨段墨色：两端都走过的轨段 strong，邻接 pending 保持浅墨", () => {
    const model = buildAawTimeline({
      sr: "SR-001",
      entry: "sr",
      status: "in_progress",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [
        step({ id: 1, finished: true }),
        step({ id: 2, executionStatus: "running" }),
        step({ id: 3 }),
      ],
    });
    expect(model.stations.map((station) => station.railStrong)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("步骤乱序输入时按 id 排序成站序列", () => {
    const model = buildAawTimeline({
      sr: "SR-001",
      entry: "sr",
      status: "in_progress",
      pendingUserConfirm: null,
      definitionDrift: null,
      steps: [
        step({ id: 3 }),
        step({ id: 1, finished: true }),
        step({ id: 2 }),
      ],
    });
    expect(model.stations.map((station) => station.stepId)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
  });

  it("plan 全图：完整站序 + 已物化步骤叠灯，未到达的站空环淡名", () => {
    const model = buildAawTimeline(
      {
        sr: "SR-001",
        entry: "dev",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        // 只物化了第 1 步（running）——SR 刚创建时的真实形状
        steps: [
          step({
            id: 1,
            type: "dev-init",
            name: "dev-init",
            executionStatus: "running",
          }),
        ],
      },
      {
        entry: "dev",
        nodes: [
          { id: "dev-init", name: "dev-init", kind: "direct", isGate: false },
          {
            id: "dev-design",
            name: "dev-design",
            kind: "direct",
            isGate: false,
          },
          {
            id: "dev-test-design",
            name: "dev-test-design",
            kind: "direct",
            isGate: false,
          },
          {
            id: "dev-design-gate",
            name: "dev-design-gate",
            kind: "choice",
            isGate: true,
          },
          {
            id: "dev-task-split",
            name: "dev-task-split",
            kind: "foreach",
            isGate: false,
          },
          {
            id: "dev-task-dev",
            name: "T{序号}-dev-task-dev",
            kind: "terminal",
            isGate: false,
          },
        ],
        edges: [],
      },
    );
    expect(model.totalCount).toBe(6);
    expect(
      model.stations.map(
        (station) => `${station.lamp}${station.materialized ? "" : "*"}`,
      ),
    ).toEqual([
      "running",
      "pending*",
      "pending*",
      "pending*",
      "pending*",
      "pending*",
    ]);
    expect(model.focusIndex).toBe(0);
    expect(model.doneCount).toBe(0);
    expect(model.stations[3]?.isGate).toBe(true);
  });
});

describe("deriveStepPhases 坏终态可见", () => {
  it("failed / blocked / superseded 不再被抹成 pending", () => {
    const phases = deriveStepPhases([
      step({ id: 1, finished: true }),
      step({ id: 2, executionStatus: "failed" }),
      step({ id: 3, executionStatus: "blocked" }),
      step({ id: 4, executionStatus: "superseded" }),
      step({ id: 5, executionStatus: "ready" }),
    ]);
    expect(phases).toEqual([
      "completed",
      "failed",
      "blocked",
      "superseded",
      "current",
    ]);
  });
});
