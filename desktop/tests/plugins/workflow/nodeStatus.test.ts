import { describe, expect, it } from "vitest";
import {
  deriveCanvasSnapshot,
  mergeStates,
  nodeStatus,
  statusLabel,
} from "../../../src/plugins/workflow/status/snapshot.ts";
import type { CanvasSnapshot } from "../../../src/plugins/workflow/types.ts";
import { runSummary } from "./helpers.ts";

/**
 * 节点状态推导纯函数测试（移植自旧 WorkflowPanel 的 nodeStatus 逻辑，
 * 含 D8 验收修复的两分支）+ deriveCanvasSnapshot 的宽容解析回归。
 */
const snapshot = (overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot => ({
  runId: "run-1",
  run: null,
  catalog: null,
  execution: null,
  active: true,
  hasLease: true,
  retries: [],
  nodes: [],
  actors: [],
  ...overrides,
});

const record = (overrides: Record<string, unknown>) =>
  ({
    siteId: "ask#1",
    ordinal: 1,
    kind: "ask",
    status: "completed",
    scope: {},
    callPath: [],
    phaseId: "first",
    actorSiteId: "",
    actorOrdinal: 0,
    result: null,
    candidates: [],
    ...overrides,
  }) as CanvasSnapshot["nodes"][number];

const node = { id: "ask#1" };

describe("nodeStatus", () => {
  // 状态词只有原型规约 §7 的八个；附加信息进 note，不改写状态词。
  it("reports 未触发 without a snapshot or without a record", () => {
    expect(nodeStatus(node, null)).toEqual({ label: "未触发", state: "pending", count: 0 });
    expect(nodeStatus(node, snapshot())).toEqual({ label: "未触发", state: "pending", count: 0 });
  });

  it("marks skipped records", () => {
    expect(nodeStatus(node, snapshot({ nodes: [record({ status: "skipped", ordinal: 2 })] })))
      .toEqual({ label: "已跳过", state: "skipped", count: 2 });
  });

  it("distinguishes running states by activity and retry authorization", () => {
    const running = record({ status: "running" });
    expect(nodeStatus(node, snapshot({ nodes: [running] })))
      .toEqual({ label: "运行中", state: "running", count: 1 });
    expect(nodeStatus(node, snapshot({ active: false, nodes: [running] })))
      .toEqual({ label: "结果待核验", state: "stuck", count: 1 });
    // 已授权重试：核验结论是「未执行」，等继续运行后重做——还没轮到。
    expect(nodeStatus(node, snapshot({
      active: false,
      retries: [{ siteId: "ask#1", ordinal: 1 }],
      nodes: [running],
    }))).toEqual({ label: "未触发", state: "pending", count: 1, note: "已授权重试一次，继续运行后重新执行" });
  });

  it("keeps 运行中 but notes that the engine is waiting for a reply in the session", () => {
    const waiting = record({ status: "running", awaitingInput: true });
    expect(nodeStatus(node, snapshot({ nodes: [waiting] })))
      .toEqual({ label: "运行中", state: "running", count: 1, note: "等你在会话里回复", noteAttention: true, awaiting: true });
    // 运行已停：残留标记不算数，按结果待核验处理。
    expect(nodeStatus(node, snapshot({ active: false, nodes: [waiting] })).state).toBe("stuck");
  });

  it("parses the engine's awaiting-input fields only when present", () => {
    const parsed = deriveCanvasSnapshot({ nodes: [
      { siteId: "ask#1", ordinal: 1, status: "running", awaitingInput: true, awaitingInputSince: 42 },
      { siteId: "ask#2", ordinal: 1, status: "running", awaitingInput: "yes" },
    ] });
    expect(parsed.nodes[0]).toMatchObject({ awaitingInput: true, awaitingInputSince: 42 });
    expect(parsed.nodes[1]).not.toHaveProperty("awaitingInput");
    expect(parsed.nodes[1]).not.toHaveProperty("awaitingInputSince");
  });

  it("reads command results: non-zero exit code fails, stdout JSON is unwrapped", () => {
    expect(nodeStatus(node, snapshot({ nodes: [record({ status: "completed", result: { exitCode: 1, stdout: "" } })] })))
      .toEqual({ label: "失败", state: "failed", count: 1 });
    const stdout = JSON.stringify({ status: "blocked" });
    expect(nodeStatus(node, snapshot({ nodes: [record({ status: "completed", result: { exitCode: 0, stdout } })] })))
      .toEqual({ label: "已阻塞", state: "blocked", count: 1 });
  });

  it("maps business decisions onto the shared vocabulary with an explanatory note", () => {
    const completed = (result: unknown) => snapshot({ nodes: [record({ status: "completed", result })] });
    expect(nodeStatus(node, completed({ status: "blocked" })).label).toBe("已阻塞");
    expect(nodeStatus(node, completed({ decision: "needs_user" }))).toMatchObject({ label: "已阻塞", note: "需要用户决定", noteAttention: true });
    expect(nodeStatus(node, completed({ decision: "unknown" }))).toMatchObject({ label: "已阻塞", note: "检查无法确认", noteAttention: true });
    expect(nodeStatus(node, completed({ simulated: true }))).toMatchObject({ label: "已完成", note: "模拟结果", noteAttention: true });
    expect(nodeStatus(node, completed({})).label).toBe("已完成");
  });

  it("keeps the D8 fix: findings/revise are flagged only while the run is active", () => {
    // D8 回归（两分支）：进行中 → 已完成 + 待处置提醒；落定后 →「已完成 ·
    // 曾报告发现」，终态画布不再看起来欠着账。
    const findings = { decision: "findings", report: "# 独立评审报告" };
    expect(nodeStatus(node, snapshot({ active: true, nodes: [record({ result: findings })] })))
      .toEqual({ label: "已完成", state: "done", count: 1, note: "报告了发现，待处置", noteAttention: true });
    expect(nodeStatus(node, snapshot({ active: false, nodes: [record({ result: findings })] })))
      .toEqual({ label: "已完成 · 曾报告发现", state: "done-findings", count: 1 });
    const revise = { decision: "revise" };
    expect(nodeStatus(node, snapshot({ active: true, nodes: [record({ result: revise })] })).note).toBe("报告了发现，待处置");
    expect(nodeStatus(node, snapshot({ active: false, nodes: [record({ result: revise })] })).label).toBe("已完成 · 曾报告发现");
  });

  it("stops flagging findings once the flow has moved on to another action", () => {
    // 设计门禁报告了发现，门禁整改随后开始执行：发现已由流程接手。
    const parsed = deriveCanvasSnapshot({ active: true, nodes: [
      { siteId: "ask#7", ordinal: 1, status: "completed", result: { decision: "revise" } },
      { siteId: "ask#8", ordinal: 1, status: "running" },
    ] });
    expect(parsed.nodes.map((item) => item.followed ?? false)).toEqual([true, false]);
    expect(nodeStatus({ id: "ask#7" }, { ...parsed, active: true }))
      .toEqual({ label: "已完成 · 曾报告发现", state: "done-findings", count: 1 });
    // 只剩它自己（流程还没接手）：仍提醒待处置。
    expect(nodeStatus({ id: "ask#7" }, { ...parsed, active: true, nodes: [{ ...parsed.nodes[0]!, followed: false }] }).note)
      .toBe("报告了发现，待处置");
  });

  it("shows the latest ordinal record and falls back to 失败 for unknown statuses", () => {
    expect(nodeStatus(node, snapshot({
      nodes: [
        record({ ordinal: 1, status: "completed", result: {} }),
        record({ ordinal: 3, status: "completed", result: {} }),
        record({ ordinal: 2, status: "completed", result: {} }),
      ],
    }))).toEqual({ label: "已完成", state: "done", count: 3 });
    expect(nodeStatus(node, snapshot({ nodes: [record({ status: "mysterious" })] })).label).toBe("失败");
  });
});

describe("mergeStates", () => {
  it("surfaces what needs a person first and only settles when everything settled", () => {
    expect(mergeStates([])).toBe("pending");
    expect(mergeStates(["done", "running"])).toBe("running");
    expect(mergeStates(["running", "stuck"])).toBe("stuck");
    expect(mergeStates(["blocked", "failed"])).toBe("failed");
    expect(mergeStates(["done", "skipped"])).toBe("done");
    expect(mergeStates(["done", "done-findings"])).toBe("done-findings");
    expect(mergeStates(["skipped", "skipped"])).toBe("skipped");
    // 部分结束、部分未触发：既不冒充已完成，也不冒充正在执行。
    expect(mergeStates(["done", "pending"])).toBe("pending");
  });
});

describe("deriveCanvasSnapshot", () => {
  it("projects a real engine run-detail payload", () => {
    // 形状对齐 workflow_service.rs Service::snapshot 的 json! 输出。
    const detail = {
      run: runSummary({ runId: "run-1", name: "AAW dev", status: "running", args: { workflowId: "aaw-dev", workflowRevision: "definition-v1" } }),
      catalog: { id: "aaw-dev", name: "AAW dev", revision: "definition-v1", entry: "first", nodes: [{ id: "ask#1", label: "需求确认", kind: "agent", steps: ["确认需求"] }], structure: { rootFlow: "main", flows: { main: { id: "main", label: "AAW dev", entry: "first", phases: [{ id: "first", run: ["ask#1"], routes: [{ next: "$complete", conditional: false }] }] } } } },
      execution: { phase: "first", stack: [], calls: [] },
      active: true,
      hasLease: false,
      retries: [{ siteId: "ask#1", ordinal: 1 }],
      nodes: [{ siteId: "ask#1", ordinal: 1, kind: "ask", status: "running", scope: { sr: "SR-1" }, callPath: [], phaseId: "first", actorSiteId: "ask#1", actorOrdinal: 1, result: null, candidates: [] }],
      actors: [{ siteId: "ask#1", ordinal: 1, name: "ask#1", sessionId: "session-1" }],
    };
    const canvas = deriveCanvasSnapshot(detail);
    expect(canvas.runId).toBe("run-1");
    expect(canvas.run?.status).toBe("running");
    expect(canvas.catalog?.nodes[0]?.label).toBe("需求确认");
    expect(canvas.catalog?.structure?.flows.main?.entry).toBe("first");
    expect(canvas.active).toBe(true);
    expect(canvas.retries).toEqual([{ siteId: "ask#1", ordinal: 1 }]);
    expect(canvas.nodes[0]?.siteId).toBe("ask#1");
    expect(canvas.actors[0]?.sessionId).toBe("session-1");
    // D8 通过投影数据同样成立：落定运行的 findings 不再是待办
    const settled = deriveCanvasSnapshot({
      run: { runId: "run-2", name: "", status: "completed", args: null, result: null, failure: null },
      active: false,
      hasLease: false,
      retries: [],
      nodes: [{ siteId: "ask#1", ordinal: 1, kind: "ask", status: "completed", result: { decision: "findings" } }],
    });
    expect(nodeStatus(node, settled).label).toBe("已完成 · 曾报告发现");
  });

  it("tolerates missing or malformed payloads", () => {
    expect(deriveCanvasSnapshot(null)).toEqual({
      runId: "", run: null, catalog: null, execution: null,
      active: false, hasLease: false, retries: [], nodes: [], actors: [],
    });
    expect(deriveCanvasSnapshot(42)).toEqual(deriveCanvasSnapshot(null));
    const junk = deriveCanvasSnapshot({ run: { runId: 7 }, nodes: ["nope", { siteId: "x" }], retries: "bad" });
    expect(junk.runId).toBe("");
    expect(junk.nodes).toHaveLength(1);
    expect(junk.nodes[0]?.siteId).toBe("x");
    expect(junk.retries).toEqual([]);
  });
});

describe("statusLabel", () => {
  const run = (overrides: Record<string, unknown>) =>
    ({ runId: "run-1", name: "AAW dev", status: "running", args: null, result: null, failure: null, ...overrides }) as CanvasSnapshot["run"] & object;

  it("labels the blocked stage with its phase name", () => {
    const catalog = deriveCanvasSnapshot({
      catalog: {
        id: "aaw-dev", name: "AAW dev", revision: "r1", entry: "first",
        nodes: [{ id: "ask#1", label: "需求确认", kind: "agent", steps: [] }],
        structure: { rootFlow: "main", flows: { main: { id: "main", label: "AAW dev", entry: "first", phases: [{ id: "first", run: ["ask#1"], routes: [] }] } } },
      },
    }).catalog;
    expect(statusLabel(run({ status: "failed", result: { status: "blocked", stage: "first" } }), catalog)).toBe("已阻塞 · 需求确认");
    expect(statusLabel(run({ status: "failed", result: { status: "blocked", stage: "missing" } }), catalog)).toBe("已阻塞");
  });

  it("labels the known run statuses", () => {
    expect(statusLabel(run({ status: "pending" }))).toBe("等待中");
    expect(statusLabel(run({ status: "completed" }))).toBe("已完成");
    expect(statusLabel(run({ status: "stopped" }))).toBe("已停止");
    expect(statusLabel(run({ status: "exotic" }))).toBe("exotic");
  });
});
