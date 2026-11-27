/**
 * 面板 UI 按原型规约适配后的行为面：阶段行与展开、单一横幅、处置（预览、
 * 撤不回确认、执行后继续）、确认关卡、停止确认、头部阶段进度。
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { CanvasSnapshot, RunSummary, WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary, findStep, clickSettled } from "./helpers.ts";

const catalog: WorkflowCatalog = {
  id: "aaw-dev", name: "AAW dev", revision: "r1", entry: "requirement",
  stages: [{ id: "design", label: "需求与设计" }, { id: "task", label: "任务" }],
  nodes: [
    { id: "ask#1", label: "需求确认", kind: "agent", steps: [] },
    { id: "ask#2", label: "设计修正", kind: "agent", steps: [] },
    { id: "ask#3", label: "任务规划", kind: "agent", steps: [] },
  ],
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "dev", entry: "requirement", phases: [
    { id: "requirement", stage: "design", run: ["ask#1"], routes: [{ next: "repair", conditional: true, label: "可修正" }, { next: "plan", conditional: false }] },
    { id: "repair", stage: "design", run: ["ask#2"], routes: [{ next: "plan", conditional: false }] },
    { id: "plan", stage: "task", run: ["ask#3"], routes: [{ next: "$complete", conditional: false }] },
  ] } } },
};
const run: RunSummary = runSummary({ runId: "run-1", name: "AAW dev", status: "running", args: { workflowId: "aaw-dev", workflowRevision: "r1" } });
const record = (siteId: string, phaseId: string, status: string, extra: Record<string, unknown> = {}) => ({
  siteId, phaseId, kind: "ask", ordinal: 1, status, actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result: status === "completed" ? { status: "ready" } : null, candidates: [], ...extra,
});
const snapshotOf = (partial: Partial<CanvasSnapshot>): CanvasSnapshot =>
  ({ runId: "run-1", run, catalog, execution: null, active: true, hasLease: true, retries: [], nodes: [], actors: [], ...partial });

function mount(snapshot: CanvasSnapshot, extra: { onOpenSession?: (id: string) => void } = {}) {
  const fake = fakeWorkflowService();
  fake.setRuns([snapshot.run!]);
  fake.setSnapshot(snapshot.runId, snapshot);
  render(<WorkflowPanel service={fake.service} {...extra} />);
  return fake;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows the stages in one row with a capsule per step, and opens a stage's steps on click", async () => {
  // 需求确认已完成、设计修正没被需要、运行已到下一阶段：需求与设计算走完了。
  mount(snapshotOf({ execution: { phase: "plan", stack: [], calls: [] }, nodes: [
    record("ask#1", "requirement", "completed"), record("ask#3", "plan", "running"),
  ] }));
  const design = await screen.findByRole("button", { name: /^1 需求与设计，已完成/ });
  const task = screen.getByRole("button", { name: /^2 任务，进行中/ });
  expect([...design.querySelectorAll(".wf-pill")].map((pill) => pill.className)).toEqual(["wf-pill tone-done", "wf-pill tone-wait"]);
  expect(task.querySelector(".wf-pill.tone-running")).not.toBeNull();
  // 默认只看阶段：步骤要点开才有。
  expect(screen.queryByRole("button", { name: "任务规划，运行中" })).not.toBeInTheDocument();
  await clickSettled(design);
  expect(screen.getByRole("button", { name: "需求确认，已完成" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "设计修正，未触发" })).toBeInTheDocument();
});

it("opens the latest round directly and lets the inspector open the original round", async () => {
  const open = vi.fn();
  mount(snapshotOf({
    nodes: [
      record("ask#1", "requirement", "completed", { sessionId: "previous", mark: "superseded" }),
      record("ask#1", "requirement", "running", { sessionId: "latest", ordinal: 2 }),
    ],
  }), { onOpenSession: open });
  await findStep("需求确认，运行中");
  fireEvent.click(screen.getByRole("button", { name: "打开「需求确认」第 2 轮会话" }));
  expect(open).toHaveBeenLastCalledWith("latest", "run-1");
  expect(screen.queryByRole("complementary", { name: "节点详情" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "需求确认，运行中" }));
  fireEvent.click(screen.getByRole("button", { name: "第 1 轮" }));
  fireEvent.click(screen.getByRole("button", { name: "打开本轮会话" }));
  expect(open).toHaveBeenLastCalledWith("previous", "run-1");
});

it("folds every abnormal state into one banner with the error code collapsed", async () => {
  const stopped: RunSummary = { ...run, status: "stopped", failure: { code: "ACTION_OUTCOME_REQUIRES_RECONCILIATION", detail: "ask#1#1: RESULT_CHANNEL_UNREACHABLE" } };
  mount(snapshotOf({ run: stopped, active: false, hasLease: false, nodes: [record("ask#1", "requirement", "running")] }));
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  const banner = alerts[0]!;
  // 首行是人话原因（细节里更具体的错误码优先），处理建议另起一行，错误码折叠在「详情」之下，主操作只有一个。
  const reason = within(banner).getByText(/节点结果的提交通道出了问题。/);
  const hint = within(banner).getByText(/可以在节点上点「处置…」/);
  expect(reason.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(banner).getByText("详情").closest("details")).not.toHaveAttribute("open");
  expect(within(banner).getAllByRole("button")).toHaveLength(1);
});

it("previews a rerun, then intervenes and continues the run", async () => {
  const stopped: RunSummary = { ...run, status: "stopped", failure: { code: "ACTION_OUTCOME_REQUIRES_RECONCILIATION" } };
  const fake = mount(snapshotOf({ run: stopped, active: false, hasLease: false, checkpoints: [{ seq: 1, prefix: [], callPath: [], phase: "requirement", createdAt: 1, available: true, current: true }], nodes: [record("ask#1", "requirement", "running", { checkpoint: 1 })] }));
  fake.setInterventionOutcome({ plan: { superseded: [{ siteId: "ask#1", ordinal: 1, label: "需求确认", status: "running" }], skipped: [], cleanup: [], cleanupProblems: [], irreversible: [], sessions: [] }, cleanupProblems: [] });
  fireEvent.click(await screen.findByRole("button", { name: "去处理" }));
  expect(screen.getByRole("button", { name: "重跑这一步" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "在原结果上修改" })).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByText(/这些步骤会重做/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/给重做这一步的意见/), { target: { value: "补上错误处理" } });
  fireEvent.click(screen.getByRole("button", { name: "执行并继续运行" }));
  await vi.waitFor(() => {
    expect(fake.calls.find((call) => call.method === "intervene")?.args).toMatchObject({
      runId: "run-1", request: { kind: "rewind", checkpoint: 1, mode: "keep", note: "补上错误处理" },
    });
    expect(fake.calls.at(-1)?.method).toBe("resume");
  });
  expect(fake.calls.find((call) => call.method === "intervene-preview")?.args).toMatchObject({ request: { kind: "rewind", checkpoint: 1, mode: "keep" } });
});

it("lists files to delete when discarding and asks before redoing irreversible work", async () => {
  const stopped: RunSummary = { ...run, status: "stopped" };
  const fake = mount(snapshotOf({ run: stopped, active: false, hasLease: false, checkpoints: [{ seq: 1, prefix: [], callPath: [], phase: "requirement", createdAt: 1, available: true, current: true }], nodes: [record("ask#1", "requirement", "completed", { checkpoint: 1 })] }));
  fake.setInterventionOutcome({ plan: {
    superseded: [{ siteId: "ask#1", ordinal: 1, label: "需求确认", status: "completed" }], skipped: [],
    cleanup: [{ path: "docs/design.md", siteId: "ask#1", kind: "file" }, { path: "docs/old.md", siteId: "ask#1", kind: "missing" }],
    cleanupProblems: [], irreversible: [{ siteId: "ask#1", label: "需求确认", reason: "会通知评审群" }], sessions: ["需求确认"],
  }, cleanupProblems: [] });
  fireEvent.click(await findStep("需求确认，已完成"));
  fireEvent.click(screen.getByRole("button", { name: "处置…" }));
  fireEvent.click(screen.getByRole("button", { name: "从头重做" }));
  expect(await screen.findByText("docs/design.md")).toBeInTheDocument();
  expect(screen.getByText(/docs\/old.md（已不存在）/)).toBeInTheDocument();
  expect(screen.getByText(/这些步骤会换新会话：需求确认/)).toBeInTheDocument();
  const execute = screen.getByRole("button", { name: "执行并继续运行" });
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(execute).toBeEnabled();
  fireEvent.click(execute);
  await vi.waitFor(() => {
    expect(fake.calls.find((call) => call.method === "intervene")?.args).toMatchObject({ request: { kind: "rewind", mode: "discard" } });
  });
});

it("stops at a confirmation gate with 继续 and 退回 on the banner", async () => {
  const waiting: RunSummary = { ...run, status: "waiting", result: { status: "waiting" } };
  const fake = mount(snapshotOf({
    run: waiting, active: false, hasLease: false, checkpoints: [{ seq: 1, prefix: [], callPath: [], phase: "requirement", createdAt: 1, available: true, current: true }],
    gates: [{ instance: [], callPath: [], phase: "requirement", next: "plan", label: "确认计划后开发", confirm: "must" }],
    nodes: [record("ask#1", "requirement", "completed", { checkpoint: 1 })],
  }));
  const banner = await screen.findByRole("alert");
  expect(banner).toHaveTextContent("「需求确认」已完成，「确认计划后开发」之前需要你确认");
  expect(await findStep("需求确认，已完成")).toHaveTextContent("等你确认后继续");
  expect(screen.getByText("等你确认")).toBeInTheDocument();
  fireEvent.click(within(banner).getByRole("button", { name: "继续" }));
  await vi.waitFor(() => {
    expect(fake.calls.find((call) => call.method === "confirm")?.args).toEqual({ runId: "run-1", instance: [] });
  });
  fireEvent.click(within(banner).getByRole("button", { name: "退回…" }));
  expect(await screen.findByRole("button", { name: "重跑这一步" })).toBeInTheDocument();
});

it("asks before stopping a running run", async () => {
  const fake = mount(snapshotOf({ active: true, nodes: [record("ask#1", "requirement", "running")] }));
  fireEvent.click(await screen.findByRole("button", { name: "停止" }));
  const group = screen.getByRole("group", { name: "确认停止" });
  expect(group).toHaveTextContent("正在执行的节点会被中断");
  expect(fake.calls.some((call) => call.method === "stop")).toBe(false);
  fireEvent.click(within(group).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("group", { name: "确认停止" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  fireEvent.click(within(screen.getByRole("group", { name: "确认停止" })).getByRole("button", { name: "停止" }));
  await vi.waitFor(() => expect(fake.calls.some((call) => call.method === "stop")).toBe(true));
});

it("does not let a superseded round decide the node state", async () => {
  mount(snapshotOf({ active: false, run: { ...run, status: "stopped" }, hasLease: false, nodes: [record("ask#1", "requirement", "completed", { mark: "superseded" })] }));
  expect(await findStep("需求确认，未触发")).toHaveTextContent("之前的结果已作废");
  fireEvent.click(screen.getByRole("button", { name: "需求确认，未触发" }));
  expect(screen.getByText("这一轮已被回退作废，只供回看。")).toBeInTheDocument();
});

it("tells the user a node is waiting for a reply and opens its session from the banner", async () => {
  // 引擎记录：这一轮结束了、结果还没交，在等用户经会话回复。
  const fake = fakeWorkflowService();
  const snapshot = snapshotOf({
    nodes: [record("ask#1", "requirement", "running", { turn: "completed", turnEndedAt: 1, actorSiteId: "ask#1", actorOrdinal: 1 })],
    actors: [{ siteId: "ask#1", ordinal: 1, name: "需求确认", sessionId: "s-1" }],
  });
  fake.setRuns([snapshot.run!]);
  fake.setSnapshot(snapshot.runId, snapshot);
  const opened: string[] = [];
  render(<WorkflowPanel service={fake.service} onOpenSession={(id) => opened.push(id)} />);
  const banner = await screen.findByRole("alert");
  expect(banner).toHaveTextContent("「需求确认」等你在会话里回复");
  // 横幅已经说了在等回复，头部只写停在哪一步。
  expect(screen.queryByText("等待回复 ·")).not.toBeInTheDocument();
  expect(screen.getByText("当前 ·")).toBeInTheDocument();
  // 状态词仍是「运行中」，附注说明在等回复。
  expect(await findStep("需求确认，运行中")).toHaveTextContent("等你在会话里回复");
  fireEvent.click(within(banner).getByRole("button", { name: "打开会话" }));
  expect(opened).toEqual(["s-1"]);
});

it("lists all waiting nodes with an independent session action", async () => {
  const fake = fakeWorkflowService();
  const snapshot = snapshotOf({
    nodes: [
      record("ask#1", "requirement", "running", { turn: "completed", actorSiteId: "ask#1", actorOrdinal: 1 }),
      record("ask#2", "design", "running", { turn: "completed", actorSiteId: "ask#2", actorOrdinal: 1 }),
    ],
    actors: [
      { siteId: "ask#1", ordinal: 1, name: "需求确认", sessionId: "s-1" },
      { siteId: "ask#2", ordinal: 1, name: "设计", sessionId: "s-2" },
    ],
  });
  fake.setRuns([snapshot.run!]);
  fake.setSnapshot(snapshot.runId, snapshot);
  const opened: string[] = [];
  render(<WorkflowPanel service={fake.service} onOpenSession={(id) => opened.push(id)} />);
  const list = await screen.findByLabelText("等待回复的节点");
  const buttons = within(list).getAllByRole("button", { name: "打开会话" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
  fireEvent.click(buttons[0]!);
  expect(opened).toEqual(["s-2", "s-1"]);
});

it("does not repeat the Agent's message in the panel, the session shows it", async () => {
  const fake = fakeWorkflowService();
  const snapshot = snapshotOf({ nodes: [record("ask#1", "requirement", "running", { turn: "completed" })] });
  fake.setRuns([snapshot.run!]);
  fake.setSnapshot(snapshot.runId, snapshot);
  render(<WorkflowPanel service={fake.service} />);
  const banner = await screen.findByRole("alert");
  act(() => fake.emit({ type: "acp-event", runId: "run-1", instance: { siteId: "ask#1", ordinal: 1 }, event: { type: "agent_message_chunk", text: "请确认范围" } }));
  expect(banner).toHaveTextContent("「需求确认」等你在会话里回复");
  expect(banner).not.toHaveTextContent("请确认范围");
  expect(screen.queryByLabelText("等待回复的节点")).not.toBeInTheDocument();
});

it("shows the Agent's own plan as node progress and timing on the card", async () => {
  const fake = fakeWorkflowService();
  const now = Date.now();
  const snapshot = snapshotOf({ nodes: [record("ask#1", "requirement", "running", { startedAt: now - 5 * 60_000 })] });
  fake.setRuns([snapshot.run!]);
  fake.setSnapshot(snapshot.runId, snapshot);
  render(<WorkflowPanel service={fake.service} />);
  const card = await findStep("需求确认，运行中");
  expect(card).toHaveTextContent("已运行 5 分钟");
  expect(card).not.toHaveTextContent("进度");

  fake.setNodePlan("run-1", "ask#1", 1, [{ content: "读需求", status: "completed" }, { content: "列出待确认问题", status: "in_progress" }]);
  act(() => fake.emit({ type: "acp-event", runId: "run-1", instance: { siteId: "ask#1", ordinal: 1 }, event: { type: "plan", entries: [] } }));
  expect(card).toHaveTextContent("进度 1/2");
  fireEvent.click(card);
  const plan = await screen.findByRole("region", { name: "Agent 的计划" });
  expect(plan).toHaveTextContent("Agent 的计划 · 1/2");
  expect(plan).toHaveTextContent("进行中列出待确认问题");
  expect(screen.queryByRole("region", { name: "节点步骤" })).not.toBeInTheDocument();
});

it("does not claim a stopped run is waiting for a reply", async () => {
  const stopped: RunSummary = { ...run, status: "stopped" };
  mount(snapshotOf({ run: stopped, active: false, hasLease: false, nodes: [record("ask#1", "requirement", "running", { turn: "completed" })] }));
  expect(await findStep("需求确认，已中断")).toBeInTheDocument();
  expect(screen.queryByText(/等你在会话里回复/)).not.toBeInTheDocument();
});

it("marks a running step's capsule as running, and as needing you while it waits for a reply", async () => {
  const done = record("ask#1", "requirement", "completed");
  mount(snapshotOf({ execution: { phase: "plan", stack: [], calls: [] }, nodes: [done, record("ask#3", "plan", "running")] }));
  const task = await screen.findByRole("button", { name: /^2 任务/ });
  expect(task.querySelector(".wf-pill")).toHaveClass("tone-running");
  cleanup();
  mount(snapshotOf({ execution: { phase: "plan", stack: [], calls: [] }, nodes: [done, record("ask#3", "plan", "running", { turn: "completed" })] }));
  const waiting = await screen.findByRole("button", { name: /^2 任务，要你处理/ });
  expect(waiting.querySelector(".wf-pill")).toHaveClass("tone-alert");
});

it("highlights the target card when jumping from the banner, not on a plain click", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const stopped: RunSummary = { ...run, status: "stopped", failure: { code: "ACTION_OUTCOME_REQUIRES_RECONCILIATION" } };
  mount(snapshotOf({ run: stopped, active: false, hasLease: false, nodes: [record("ask#1", "requirement", "running")] }));
  const card = await findStep("需求确认，已中断");
  fireEvent.click(card);
  expect(card.closest(".wf-step")).not.toHaveClass("flash");
  fireEvent.click(screen.getByRole("button", { name: "去处理" }));
  expect(screen.getByRole("button", { name: "需求确认，已中断" }).closest(".wf-step")).toHaveClass("flash");
  act(() => { vi.advanceTimersByTime(1600); });
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "需求确认，已中断" }).closest(".wf-step")).not.toHaveClass("flash"));
  vi.useRealTimers();
});

