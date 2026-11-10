/**
 * workflowModel 解析器回归：样本与 aaw CLI `status` / `next`
 * 实际输出同形状（tests/fixtures/aawWorkflowSamples.ts），另覆盖非法
 * 形状与错误信封。
 */
import { describe, expect, it } from "vitest";
import { formatArgvPreview, isGateStepType, parseCliError, parseNextPayload, parseSrList, parseWorkflowStatus } from "../../../src/plugins/workflow/status/workflowModel.ts";
import { deriveStepPhases } from "../../../src/plugins/workflow/service.ts";
import {
  sampleCliErrorJson,
  sampleNextAwaitingJson,
  sampleNextJson,
  sampleSrListJson,
  sampleStatusJson,
} from "../../fixtures/aawWorkflowSamples.ts";

describe("parseSrList", () => {
  it("解析 SR 列表", () => {
    expect(parseSrList(sampleSrListJson)).toEqual({
      srs: ["SR-001", "SR-004"],
    });
  });

  it("非法形状返回 null", () => {
    for (const raw of ["", 42, {}, { ok: true, srs: "SR-001" }, null]) {
      expect(parseSrList(raw)).toBeNull();
    }
  });
});

describe("parseWorkflowStatus", () => {
  it("解析步骤投影并标记门禁", () => {
    const status = parseWorkflowStatus(sampleStatusJson);
    expect(status).not.toBeNull();
    expect(status?.sr).toBe("SR-004");
    expect(status?.entry).toBe("dev");
    expect(status?.status).toBe("in_progress");
    expect(status?.steps).toHaveLength(6);

    const gate = status?.steps.find((step) => step.type === "dev-design-gate");
    expect(gate?.isGate).toBe(true);
    expect(gate?.finished).toBe(false);
    expect(gate?.executionStatus).toBe("ready");

    const first = status?.steps[0];
    expect(first?.finished).toBe(true);
    expect(first?.executionStatus).toBe("completed");
    expect(status?.pendingUserConfirm).toBeNull();
  });

  it("缺关键字段返回 null", () => {
    expect(parseWorkflowStatus({ ok: true, steps: [] })).toBeNull();
    expect(
      parseWorkflowStatus({ ok: true, sr: "SR-1", entry: "dev", status: "x" }),
    ).toBeNull();
  });
});

describe("parseNextPayload", () => {
  it("解析就绪工作单摘要", () => {
    const payload = parseNextPayload(sampleNextJson);
    expect(payload).not.toBeNull();
    expect(payload?.sr).toBe("SR-004");
    expect(payload?.done).toBe(false);
    expect(payload?.awaitingUserConfirm).toBe(false);
    expect(payload?.ready).toHaveLength(1);

    const order = payload?.ready[0];
    expect(order?.id).toBe(3);
    expect(order?.type).toBe("dev-test-design");
    expect(order?.execution).toBe("skill");
    expect(order?.skill).toEqual(["dev-test-design"]);
    expect(order?.dataRequired).toBe(true);
    expect(order?.deliverablesReady).toBe(false);
    expect(order?.inputs?.blocked).toBe(false);
    expect(order?.doneArgv).toContain("done");
    expect(order?.doneArgv).toContain("SR-004");
  });

  it("解析 awaiting_user_confirm 信封", () => {
    const payload = parseNextPayload(sampleNextAwaitingJson);
    expect(payload).not.toBeNull();
    expect(payload?.awaitingUserConfirm).toBe(true);
    expect(payload?.ready).toHaveLength(0);
    expect(payload?.pendingUserConfirm?.fromStep).toBe(3);
    expect(payload?.pendingUserConfirm?.plannedNext[0]?.name).toBe("设计门禁");
    expect(payload?.userConfirmArgv).toContain("user-confirm");
  });

  it("缺 done 字段返回 null", () => {
    expect(
      parseNextPayload({
        ok: true,
        sr: "S",
        entry: "dev",
        status: "x",
        ready: [],
      }),
    ).toBeNull();
  });
});

describe("parseCliError", () => {
  it("解析失败信封", () => {
    expect(parseCliError(sampleCliErrorJson)).toEqual({
      code: "WORKFLOW_NOT_FOUND",
      message: "SR SR-404 不存在",
    });
  });

  it("成功信封与垃圾形状返回 null", () => {
    expect(parseCliError(sampleStatusJson)).toBeNull();
    expect(parseCliError("nope")).toBeNull();
  });
});

describe("deriveStepPhases", () => {
  it("已完成 / 当前 / 待办 三态推导", () => {
    const status = parseWorkflowStatus(sampleStatusJson);
    expect(status).not.toBeNull();
    const phases = deriveStepPhases(status?.steps ?? []);
    // 样本数据：1-2 完成，3 running（当前），4-6 待办
    expect(phases).toEqual([
      "completed",
      "completed",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("无 running 时第一个 ready 成为当前", () => {
    const phases = deriveStepPhases([
      {
        id: 1,
        type: "dev-init",
        name: "确认需求",
        execution: "skill",
        finished: true,
        executionStatus: "completed",
        isGate: false,
      },
      {
        id: 2,
        type: "dev-design",
        name: "功能设计",
        execution: "skill",
        finished: false,
        executionStatus: "ready",
        isGate: false,
      },
      {
        id: 3,
        type: "dev-design-gate",
        name: "设计门禁",
        execution: "skill",
        finished: false,
        executionStatus: "ready",
        isGate: true,
      },
    ]);
    expect(phases).toEqual(["completed", "current", "pending"]);
  });
});

describe("辅助函数", () => {
  it("isGateStepType 按 -gate 后缀判定", () => {
    expect(isGateStepType("sr-design-gate")).toBe(true);
    expect(isGateStepType("module-design-gate")).toBe(true);
    expect(isGateStepType("dev-design")).toBe(false);
  });

  it("formatArgvPreview 对含空格参数加引号", () => {
    expect(formatArgvPreview(["python", "a b.py", "--json"])).toBe(
      'python "a b.py" --json',
    );
  });
});
