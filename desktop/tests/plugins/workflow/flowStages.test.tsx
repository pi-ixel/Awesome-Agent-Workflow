import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { clickSettled } from "./helpers.ts";
import { FlowStages } from "../../../src/plugins/workflow/ui/FlowStages.tsx";
import { expandDependencies, flowStages, frameSteps, toneOf } from "../../../src/plugins/workflow/ui/flowModel.ts";
import type { CanvasSnapshot, HierarchyStructure, WorkflowCatalogNode, WorkflowStage } from "../../../src/plugins/workflow/types.ts";

/**
 * 流程图：阶段行 + 胶囊；点阶段展开步骤，点子流程向右展开（jsdom 没有 Web Animations，
 * 这里只验结构与交互，动画由截图核对）。
 */
const structure: HierarchyStructure = {
  rootFlow: "main",
  flows: {
    main: {
      id: "main", label: "主流程", entry: "requirement", phases: [
        { id: "requirement", stage: "design", run: ["ask"], routes: [{ next: "review", conditional: false }] },
        { id: "review", stage: "design", run: ["check"], routes: [{ next: "repair", conditional: true }, { next: "plan", conditional: true }] },
        { id: "repair", stage: "design", run: ["fix"], routes: [{ next: "review", conditional: false }] },
        { id: "plan", stage: "dev", run: ["plan"], routes: [{ next: "tasks", conditional: false, confirm: "must" }] },
        { id: "tasks", stage: "dev", run: [], call: "task", foreach: { maxConcurrency: 1 }, routes: [{ next: "$complete", conditional: false }] },
      ],
    },
    task: {
      id: "task", label: "任务开发", entry: "impl", phases: [
        { id: "impl", run: ["impl"], routes: [{ next: "reviews", conditional: false }] },
        { id: "reviews", run: [], call: "review", routes: [{ next: "$return", conditional: false }] },
      ],
    },
    review: {
      id: "review", label: "代码评审", entry: "pair", phases: [
        { id: "pair", run: ["a", "b"], routes: [{ next: "$return", conditional: false }] },
      ],
    },
  },
};
const stages: WorkflowStage[] = [{ id: "design", label: "设计" }, { id: "dev", label: "开发" }];
const nodes = [
  { id: "ask", label: "需求确认", kind: "agent", steps: ["确认需求与边界"] },
  { id: "check", label: "设计检查", kind: "agent", steps: [] },
  { id: "fix", label: "设计修正", kind: "agent", steps: [] },
  { id: "plan", label: "任务规划", kind: "agent", steps: [] },
  { id: "impl", label: "实现", kind: "agent", steps: [] },
  { id: "a", label: "评审员 A", kind: "agent", steps: [] },
  { id: "b", label: "评审员 B", kind: "python", steps: [] },
] as unknown as WorkflowCatalogNode[];
const record = (siteId: string, phaseId: string, status: string, callPath: string[] = [], ordinal = 1) => ({ siteId, phaseId, ordinal, status, callPath, candidates: [], scope: {} });
const snapshot = {
  runId: "run-1",
  active: true,
  run: { runId: "run-1", name: "", status: "running", args: null, result: null, failure: null },
  execution: { phase: "pair", stack: [], calls: [
    { id: "tasks@1", phase: "tasks", flow: "task", ordinal: 1, parent: null, status: "completed", scope: {} },
    { id: "tasks@2", phase: "tasks", flow: "task", ordinal: 2, parent: null, status: "running", scope: {} },
    { id: "tasks@3", phase: "tasks", flow: "task", ordinal: 3, parent: null, status: "pending", scope: {} },
    { id: "reviews@2", phase: "reviews", flow: "review", ordinal: 1, parent: "tasks@2", status: "running", scope: {} },
  ] },
  retries: [],
  hasLease: true,
  catalog: null,
  nodes: [
    record("ask", "requirement", "completed"),
    record("check", "review", "completed"),
    record("plan", "plan", "completed"),
    record("impl", "impl", "completed", ["tasks@1"]),
    record("impl", "impl", "completed", ["tasks@2"]),
    record("a", "pair", "completed", ["tasks@2", "reviews@2"]),
    record("b", "pair", "running", ["tasks@2", "reviews@2"]),
  ],
} as unknown as CanvasSnapshot;
const ctx = (snap: CanvasSnapshot | null) => ({ structure, nodeMap: new Map(nodes.map((n) => [n.id, n])), snapshot: snap });

it("groups steps by stage in route order, folding loops into the order once", () => {
  const views = flowStages(ctx(snapshot), "requirement", stages, "dev");
  expect(views.map((v) => [v.label, v.steps.map((s) => s.label)])).toEqual([
    ["设计", ["需求确认", "设计检查", "设计修正"]],
    ["开发", ["任务规划", "任务开发"]],
  ]);
  // 部分完成、没走到的修正不算阻塞：阶段已经过去，按完成看（修正没被需要）。
  expect(views[1]!.steps.map((s) => toneOf(s))).toEqual(["done", "running"]);
  expect(views[1]!.steps[0]!.confirm).toBe(true);
});

it("picks the running instance of a repeated subflow and counts finished ones", () => {
  const tasks = flowStages(ctx(snapshot), "requirement", stages, "dev")[1]!.steps[1]!;
  expect(tasks.child?.frame.instanceId).toBe("tasks@2");
  expect(tasks.child?.tag).toBe("已完成 1 / 3");
  const inner = frameSteps(ctx(snapshot), tasks.child!.frame, ["tasks@2"]);
  expect(inner.map((s) => [s.label, s.state])).toEqual([["实现", "done"], ["代码评审", "running"]]);
});

it("splits a parallel phase into one step per action", () => {
  const steps = frameSteps(ctx(snapshot), { flow: "review", entry: "pair", via: "reviews", instanceId: "reviews@2" });
  expect(steps.map((s) => [s.label, s.state])).toEqual([["评审员 A", "done"], ["评审员 B", "running"]]);
});

it("puts a workflow without stages into one stage named after the workflow", () => {
  const views = flowStages(ctx(null), "requirement", [], "dev 工作流");
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ label: "dev 工作流", word: "5 步" });
});

it("expands dependency graphs into one step per action without inventing work", () => {
  const flat = { id: "work", label: "w", entry: "work", phases: [{ id: "work", run: ["impl", "a"], edges: [{ from: "impl", to: "a" }], routes: [{ next: "$complete", conditional: false }] }] };
  const expanded = expandDependencies(flat, "work", new Map(nodes.map((n) => [n.id, n])));
  expect(expanded.flow.phases.flatMap((p) => p.run)).toEqual(["impl", "a"]);
});

it("shows stages with one capsule per step, then hangs the steps under a stage when clicked", async () => {
  const select = vi.fn();
  const { container } = render(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={snapshot} onSelect={select} />);
  const design = screen.getByRole("button", { name: /^1 设计，已完成，展开步骤/ });
  expect(design.querySelectorAll(".wf-pill")).toHaveLength(3);
  expect(screen.getByRole("button", { name: /^2 开发，进行中/ }).querySelectorAll(".wf-pill.tone-running")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /需求确认/ })).not.toBeInTheDocument();

  await clickSettled(design);
  // 展开后胶囊变成了下面的步骤：原位不显示，但留着位置，阶段块不变形。
  expect(design.querySelector(".wf-pills")).toHaveClass("gone");
  fireEvent.click(screen.getByRole("button", { name: "需求确认，已完成" }));
  expect(select).toHaveBeenCalledWith("ask", [], "requirement");
  expect(container.querySelectorAll(".wf-col")).toHaveLength(1);
});

it("opens subflows to the right, level by level, and closes them again", async () => {
  render(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={snapshot} onSelect={() => {}} />);
  await clickSettled(screen.getByRole("button", { name: /^2 开发/ }));
  const tasks = screen.getByRole("button", { name: /任务开发.*展开子流程/ });
  expect(within(tasks).getByText("已完成 1 / 3")).toBeInTheDocument();
  await clickSettled(tasks);
  expect(screen.getByText("任务开发", { selector: ".wf-col-head b" })).toBeInTheDocument();
  await clickSettled(screen.getByRole("button", { name: /代码评审.*展开子流程/ }));
  expect(screen.getByRole("button", { name: "评审员 B，运行中" })).toBeInTheDocument();
  expect(screen.getByText("脚本")).toBeInTheDocument();
  // Esc 一层层收回。
  await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: "评审员 B，运行中" }), { key: "Escape" }); await Promise.resolve(); });
  expect(screen.queryByRole("button", { name: "评审员 B，运行中" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "实现，已完成" })).toBeInTheDocument();
});

it("switches straight to another stage, collapsing the open one", async () => {
  render(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={snapshot} onSelect={() => {}} />);
  await clickSettled(screen.getByRole("button", { name: /^1 设计/ }));
  await clickSettled(screen.getByRole("button", { name: /^2 开发/ }));
  expect(screen.queryByRole("button", { name: "需求确认，已完成" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "任务规划，已完成" })).toBeInTheDocument();
});

it("previews templates without run states and keeps draft previews read-only", async () => {
  render(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={null} />);
  await clickSettled(screen.getByRole("button", { name: /^1 设计，3 步/ }));
  expect(screen.queryByRole("button", { name: /需求确认/ })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "需求确认" })).toHaveTextContent("确认需求与边界");
  expect(screen.queryByText("已完成")).not.toBeInTheDocument();
});

it("reveals a node asked for from outside, opening the levels on the way", () => {
  const { rerender } = render(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={snapshot} onSelect={() => {}} />);
  act(() => { rerender(<FlowStages entry="requirement" structure={structure} nodes={nodes} stages={stages} snapshot={snapshot} onSelect={() => {}} reveal={{ site: "b", phaseId: "pair", token: 1 }} />); });
  expect(screen.getByRole("button", { name: "评审员 B，运行中" }).closest(".wf-step")).toHaveClass("flash");
});
