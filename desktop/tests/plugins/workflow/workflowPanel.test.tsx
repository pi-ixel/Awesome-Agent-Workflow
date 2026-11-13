import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { CanvasSnapshot, RunSummary, WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService } from "./helpers.ts";

/**
 * 移植自 commit 24877d9 的 tests/ui/workflowPanel.test.tsx：以可编程的
 * WorkflowService 测试替身驱动（原用例 spy core/workflowService.request）。
 * 「需要回答」用例未移植：权限/问答直答卡本期不挂（面板内只读会话流，
 * ADR 024 §9 开放问题 1）。
 */
const flow: WorkflowCatalog = {
  id: "aaw-dev", name: "AAW dev", revision: "r1",
  nodes: [
    { id: "ask#1", label: "需求确认", kind: "agent", steps: ["确认需求"] },
    { id: "world-read#1", label: "CodeCheck", kind: "python", steps: ["调用检查器"] },
  ],
  entry: "first",
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "AAW dev", entry: "first", phases: [
    { id: "first", run: ["ask#1"], routes: [{ next: "second", conditional: false }] },
    { id: "second", run: ["world-read#1"], routes: [{ next: "$complete", conditional: false }] },
  ] } } },
};
const run: RunSummary = { runId: "run-1", name: "AAW dev", status: "running", args: { workflowId: "aaw-dev", workflowRevision: "r1" }, result: null, failure: null };
const linkedSnapshot = (nodes: unknown[], actors: unknown[] = []): CanvasSnapshot =>
  ({ runId: "run-1", run, catalog: flow, execution: null, active: true, hasLease: true, retries: [], nodes, actors } as unknown as CanvasSnapshot);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders persisted node state and opens the node's adopted session in the central SessionView", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([run]);
  fake.setSnapshot("run-1", linkedSnapshot(
    [{ siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "running", actorSiteId: "ask#1", actorOrdinal: 1, callPath: [], scope: {}, result: null, candidates: [] }],
    [{ siteId: "ask#1", ordinal: 1, name: "设计", sessionId: "wf-session-1" }],
  ));
  const opened: string[] = [];
  render(<WorkflowPanel service={fake.service} onOpenSession={(sessionId) => opened.push(sessionId)} />);
  expect(await screen.findByRole("button", { name: "需求确认，运行中" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "CodeCheck，未触发" })).toBeInTheDocument();
  // 节点详情：按执行轮次展示关联会话；「打开会话」走中央 SessionView
  // （节点会话已收养进标准会话体系，面板内不再有只读会话流）。
  fireEvent.click(screen.getByRole("button", { name: "需求确认，运行中" }));
  expect(await screen.findByText("第 1 次 · 执行中")).toBeInTheDocument();
  expect(screen.queryByLabelText("会话流")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开会话 ↗" }));
  await vi.waitFor(() => {
    expect(opened).toEqual(["wf-session-1"]);
  });
  // 本期无直答交互：核验/问答动作没有被面板越权发起
  expect(fake.calls.filter((call) => call.method === "authorizeRetry" || call.method === "reconcile")).toEqual([]);
});

it("shows 尚无会话 for an executed node without an actor link, and no session area for Python nodes", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([run]);
  fake.setSnapshot("run-1", linkedSnapshot([
    { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "running", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [] },
  ]));
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "需求确认，运行中" }));
  expect(await screen.findByText("尚无会话")).toBeInTheDocument();
  // Python 节点不渲染关联会话区，不假装有 Agent 会话
  fireEvent.click(screen.getByRole("button", { name: "CodeCheck，未触发" }));
  expect(screen.queryByLabelText("关联会话")).not.toBeInTheDocument();
});

it("does not show an abandoned running action as active", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([run]);
  fake.setSnapshot("run-1", { ...linkedSnapshot([]), active: false, hasLease: true, nodes: [
    { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "running", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [] },
  ] as CanvasSnapshot["nodes"] });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("button", { name: "需求确认，结果待核验" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查并解除占用" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
});

it("lets the user inspect a submitted candidate before explicitly reconciling it", async () => {
  const candidate = { status: "ready", reference: "需求引用", evidence: "原始证据" };
  const fake = fakeWorkflowService();
  fake.setRuns([{ ...run, status: "failed" }]);
  fake.setSnapshot("run-1", { ...linkedSnapshot([]), active: false, hasLease: false, nodes: [
    { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "running", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [{ id: "c1", state: "submitted", result: candidate, createdAt: 1 }] },
  ] as CanvasSnapshot["nodes"] });
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "需求确认，结果待核验" }));
  fireEvent.click(screen.getByText(/Agent 已提交的候选结果/));
  fireEvent.click(screen.getByRole("button", { name: "使用此结果进行核验" }));
  expect(screen.queryByLabelText(/真实输出/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("核验证据"), { target: { value: "已核对会话记录" } });
  fireEvent.click(screen.getByRole("button", { name: "登记核验结论" }));
  await vi.waitFor(() => {
    const call = fake.calls.find((item) => item.method === "reconcile");
    expect(call?.args).toMatchObject({ runId: "run-1", site: "ask#1#1", resolution: { executed: true, result: candidate, evidence: "已核对会话记录" } });
  });
});

it("exposes a failed script for evidence-based retry instead of marking it complete", async () => {
  const fake = fakeWorkflowService();
  const stopped: RunSummary = { ...run, status: "stopped" };
  fake.setRuns([stopped]);
  fake.setSnapshot("run-1", { runId: "run-1", run: stopped, catalog: flow, execution: null, active: false, hasLease: false, retries: [], actors: [], nodes: [
    { siteId: "world-read#1", phaseId: "second", kind: "world-run", ordinal: 1, status: "failed", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: { exitCode: 1, stdout: "", stderr: "failed" }, candidates: [] },
  ] });
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "CodeCheck，失败" }));
  expect(screen.getByRole("button", { name: "核验动作结果" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "继续运行" })).toBeDisabled();
});

it("shows a business-blocked result as blocked rather than completed", async () => {
  const blocked: RunSummary = { ...run, status: "failed", result: { status: "blocked", stage: "first", reason: "missing information" } };
  const fake = fakeWorkflowService();
  fake.setRuns([blocked]);
  fake.setSnapshot("run-1", { runId: "run-1", run: blocked, catalog: flow, execution: null, active: false, hasLease: false, retries: [], actors: [], nodes: [
    { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "completed", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: { status: "blocked", evidence: "missing information" }, candidates: [] },
  ] });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("button", { name: "需求确认，已阻塞" })).toBeInTheDocument();
  expect(screen.getByText("已阻塞 · 需求确认")).toBeInTheDocument();
});

it("shows a persisted runtime failure after the page reloads", async () => {
  const stopped: RunSummary = { ...run, status: "stopped", failure: { code: "CONDITION_NOT_BOOLEAN", detail: null } };
  const fake = fakeWorkflowService();
  fake.setRuns([stopped]);
  fake.setSnapshot("run-1", { runId: "run-1", run: stopped, catalog: flow, execution: null, active: false, hasLease: false, retries: [], nodes: [], actors: [] });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("连线条件未返回布尔值");
});

it("shows the failure detail and jumps straight to reconciliation from the banner", async () => {
  // D1/D5 回归：停摆横幅必须带出引擎记录的具体错误与动作标识，
  // 并提供直达核验面板的入口，而不是让用户在画布上猜哪个节点卡了。
  const stopped: RunSummary = { ...run, status: "stopped", failure: { code: "ACTION_OUTCOME_REQUIRES_RECONCILIATION", detail: "world-read#1#2: PYTHON_OUTCOME_UNKNOWN" } };
  const fake = fakeWorkflowService();
  fake.setRuns([stopped]);
  fake.setSnapshot("run-1", { runId: "run-1", run: stopped, catalog: flow, execution: null, active: false, hasLease: false, retries: [], actors: [], nodes: [
    { siteId: "world-read#1", phaseId: "second", kind: "world-run", ordinal: 2, status: "running", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [] },
  ] });
  render(<WorkflowPanel service={fake.service} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("动作执行异常，请核验后处理");
  expect(alert).toHaveTextContent("world-read#1#2: PYTHON_OUTCOME_UNKNOWN");
  fireEvent.click(screen.getByRole("button", { name: "去处理" }));
  expect(await screen.findByText("请先独立核验该动作的实际执行情况；系统不会自动验证证据。")).toBeInTheDocument();
  // 「去处理」已选中卡住的节点：画布节点与详情标题都在展示 CodeCheck
  expect(screen.getAllByText("CodeCheck").length).toBeGreaterThanOrEqual(2);
});

it("marks findings as handled once the run has settled, and pending while active", async () => {
  // D8 回归：终态画布上「有发现」的已完成节点不得再标「需处理」——运行落定
  // 后不会再有人处置它；进行中才它是待办。
  const findings = { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "completed", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: { decision: "findings", report: "# 独立评审报告" }, candidates: [] };
  const renderWith = async (active: boolean, theRun: RunSummary, expected: string) => {
    const fake = fakeWorkflowService();
    fake.setRuns([theRun]);
    fake.setSnapshot(theRun.runId, { runId: theRun.runId, run: theRun, catalog: flow, execution: null, active, hasLease: active, retries: [], nodes: [findings], actors: [] });
    render(<WorkflowPanel service={fake.service} />);
    expect(await screen.findByRole("button", { name: expected })).toBeInTheDocument();
    cleanup();
  };
  // 落定后：同一节点不再标「需处理」（D8）——先渲染落定态再渲染进行中，
  // 避免首个 mock 快照异步落地晚于第二次渲染导致的状态串场。
  await renderWith(false, { ...run, runId: "run-2" }, "需求确认，已完成 · 曾报告发现");
  await renderWith(true, run, "需求确认，需处理");
});

it("reloads the graph after a failed service startup", async () => {
  let unavailable = true;
  const fake = fakeWorkflowService();
  fake.setRuns([]);
  fake.service.refresh = async () => {
    if (unavailable) throw new Error("service unavailable");
    fake.setRuns([run]);
  };
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  fake.setSnapshot("run-1", linkedSnapshot([
    { siteId: "ask#1", phaseId: "first", kind: "ask", ordinal: 1, status: "completed", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [] },
  ]));
  expect(await screen.findByRole("button", { name: "需求确认，已完成" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("renders the selected run's captured definition instead of the current template", async () => {
  const customFlow: WorkflowCatalog = {
    id: "custom", name: "自定义流程", revision: "r1",
    nodes: [{ id: "custom-agent", label: "自定义节点", kind: "agent", steps: [] }],
    entry: "custom-phase",
    structure: { rootFlow: "main", flows: { main: { id: "main", label: "自定义", entry: "custom-phase", phases: [
      { id: "custom-phase", run: ["custom-agent"], routes: [{ next: "$complete", conditional: false }] },
    ] } } },
  };
  const customRun: RunSummary = { runId: "custom-run", name: "自定义流程", status: "running", args: { workflowId: "custom", workflowRevision: "r1" }, result: null, failure: null };
  const fake = fakeWorkflowService();
  fake.setRuns([customRun]);
  fake.setSnapshot("custom-run", { runId: "custom-run", run: customRun, catalog: customFlow, execution: null, active: true, hasLease: true, retries: [], actors: [], nodes: [
    { siteId: "custom-agent", phaseId: "custom-phase", kind: "ask", ordinal: 1, status: "running", actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: null, candidates: [] },
  ] });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("button", { name: "自定义节点，运行中" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "需求确认，未触发" })).not.toBeInTheDocument();
  expect(screen.getByText("自定义流程")).toBeInTheDocument();
});
