import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowHierarchy } from "../../../src/plugins/workflow/ui/WorkflowHierarchy.tsx";
import type {
  CanvasSnapshot,
  HierarchyStructure,
  WorkflowCatalogNode,
} from "../../../src/plugins/workflow/types.ts";

/**
 * 移植自 commit 24877d9 的 tests/ui/workflowHierarchy.test.tsx：纯组件
 * 用例原样保留；快照/节点字面量按 CanvasSnapshot/WorkflowCatalogNode 的
 * 完整形状断言收窄（测试只填组件读取的字段）。
 */
const structure: HierarchyStructure = {
  rootFlow: "main",
  flows: {
    main: {
      id: "main", label: "主流程", entry: "implement", phases: [
        { id: "implement", run: ["impl"], routes: [{ next: "review-call", conditional: false }] },
        { id: "review-call", run: [], call: "review", routes: [{ next: "scan", conditional: false }] },
        { id: "scan", run: ["scan"], routes: [{ next: "$complete", conditional: false }] },
      ],
    },
    review: {
      id: "review", label: "评审与处置", entry: "reviews", phases: [
        { id: "reviews", run: ["a", "b"], routes: [{ next: "fix", label: "有发现", conditional: true }, { next: "$return", label: "无发现", conditional: true }] },
        { id: "fix", run: ["fix"], routes: [{ next: "reviews", label: "复核", conditional: false }, { next: "$blocked", conditional: true }] },
      ],
    },
  },
};
const nodes = [
  { id: "impl", label: "实现", kind: "agent", steps: [] },
  { id: "scan", label: "检查", kind: "python", steps: [] },
  { id: "a", label: "Reviewer A", kind: "agent", steps: [] },
  { id: "b", label: "Reviewer B", kind: "agent", steps: [] },
  { id: "fix", label: "处置", kind: "agent", steps: [] },
] as unknown as WorkflowCatalogNode[];
const snapshot = {
  runId: "run-1",
  active: true,
  run: { runId: "run-1", name: "", status: "running", args: null, result: null, failure: null },
  execution: { phase: "reviews", stack: [{ phase: "review-call", flow: "review", instanceId: "review-call@1" }], calls: [{ id: "review-call@1", phase: "review-call", flow: "review", ordinal: 1, parent: null, status: "running", scope: {} }] },
  retries: [],
  hasLease: true,
  catalog: null,
  nodes: [
    { siteId: "a", phaseId: "reviews", ordinal: 1, status: "running", callPath: ["review-call@1"] },
    { siteId: "b", phaseId: "reviews", ordinal: 1, status: "running", callPath: ["review-call@1"] },
  ],
} as unknown as CanvasSnapshot;

it("uses protocol calls and presents the parallel actions and their actual routes", () => {
  const select = vi.fn();
  const { container } = render(<WorkflowHierarchy entry="implement" structure={structure} nodes={nodes} snapshot={snapshot} selected="" onSelect={select} />);
  fireEvent.click(screen.getByRole("button", { name: "进入子流程 ›" }));
  expect(screen.getByRole("region", { name: "并行执行" })).toHaveTextContent("运行中");
  fireEvent.click(screen.getByRole("button", { name: "Reviewer A，运行中" }));
  expect(select).toHaveBeenCalledWith("a", ["review-call@1"], "reviews");
  const paths = Array.from(container.querySelectorAll("svg[aria-label='执行关系'] g")).map((g) => `${g.getAttribute("data-from")}→${g.getAttribute("data-to")}`);
  expect(paths).toEqual(["reviews→fix", "reviews→$return", "fix→reviews", "fix→$blocked"]);
  expect(screen.getByText("复核")).toBeInTheDocument();
});

it("opens the real enclosing subflow when navigating to an active agent", () => {
  render(<WorkflowHierarchy entry="implement" structure={structure} nodes={nodes} snapshot={snapshot} selected="" runningSite="b" onSelect={() => {}} />);
  expect(within(screen.getByLabelText("子流程路径")).getByRole("button", { name: "评审与处置" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reviewer B，运行中" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "主流程" }));
  expect(screen.getByRole("region", { name: "评审与处置" })).toHaveTextContent("运行中");
});

it("separates repeated subflow instances instead of mixing their action records", () => {
  const repeated = {
    ...snapshot,
    execution: { phase: "reviews", stack: [{ phase: "review-call", flow: "review", instanceId: "review-call@2" }], calls: [
      { id: "review-call@1", phase: "review-call", flow: "review", ordinal: 1, parent: null, status: "completed", scope: { taskId: "T1" } },
      { id: "review-call@2", phase: "review-call", flow: "review", ordinal: 2, parent: null, status: "running", scope: { taskId: "T2" } },
    ] },
    nodes: [
      { siteId: "a", phaseId: "reviews", ordinal: 1, status: "completed", callPath: ["review-call@1"] },
      { siteId: "a", phaseId: "reviews", ordinal: 2, status: "running", callPath: ["review-call@2"] },
    ],
  } as unknown as CanvasSnapshot;
  render(<WorkflowHierarchy entry="implement" structure={structure} nodes={nodes} snapshot={repeated} selected="" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "进入子流程 ›" }));
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("执行实例"), { target: { value: "review-call@1" } });
  expect(screen.getByRole("button", { name: "Reviewer A，已完成" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reviewer B，未触发" })).toBeInTheDocument();
});

it("opens a running instance when later instances are still waiting", () => {
  const dynamicStructure: HierarchyStructure = { ...structure, flows: { ...structure.flows, main: { ...structure.flows.main!, phases: structure.flows.main!.phases.map((phase) => phase.id === "review-call" ? { ...phase, foreach: { maxConcurrency: 2 } } : phase) } } };
  const multi = {
    ...snapshot,
    execution: { phase: "review-call", stack: [], calls: [
      { id: "review-call@1", phase: "review-call", flow: "review", ordinal: 1, parent: null, status: "running", scope: { item: "one" } },
      { id: "review-call@2", phase: "review-call", flow: "review", ordinal: 2, parent: null, status: "running", scope: { item: "two" } },
      { id: "review-call@3", phase: "review-call", flow: "review", ordinal: 3, parent: null, status: "pending", scope: { item: "three" } },
    ] },
    nodes: [
      { siteId: "a", phaseId: "reviews", ordinal: 1, status: "running", callPath: ["review-call@1"] },
      { siteId: "a", phaseId: "reviews", ordinal: 2, status: "running", callPath: ["review-call@2"] },
    ],
  } as unknown as CanvasSnapshot;
  render(<WorkflowHierarchy entry="implement" structure={dynamicStructure} nodes={nodes} snapshot={multi} selected="" onSelect={() => {}} />);
  expect(screen.getByRole("region", { name: "评审与处置" })).toHaveTextContent("运行中");
  expect(screen.getByText("已完成 0 / 3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /进入子流程/ }));
  expect(screen.getByLabelText("执行实例")).toHaveValue("review-call@1");
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("执行实例"), { target: { value: "review-call@3" } });
  expect(screen.getByRole("button", { name: "Reviewer A，未触发" })).toBeInTheDocument();
});

it("keeps the user's subflow open when an equivalent runtime snapshot refreshes", () => {
  const { rerender } = render(<WorkflowHierarchy entry="implement" structure={structure} nodes={nodes} snapshot={snapshot} selected="" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "进入子流程 ›" }));
  rerender(<WorkflowHierarchy entry="implement" structure={JSON.parse(JSON.stringify(structure)) as HierarchyStructure} nodes={nodes} snapshot={{ ...snapshot }} selected="" onSelect={() => {}} />);
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
});

it("distinguishes the same action definition used by two different phases", () => {
  const reused: HierarchyStructure = { rootFlow: "main", flows: { main: { id: "main", label: "主流程", entry: "first", phases: [
    { id: "first", run: ["impl"], routes: [{ next: "second", conditional: false }] },
    { id: "second", run: ["impl"], routes: [{ next: "$complete", conditional: false }] },
  ] } } };
  render(<WorkflowHierarchy entry="first" structure={reused} nodes={nodes} snapshot={{ runId: "run-1", active: false, run: { runId: "run-1", name: "", status: "stopped", args: null, result: null, failure: null }, execution: null, retries: [], hasLease: false, catalog: null, nodes: [{ siteId: "impl", phaseId: "first", ordinal: 1, status: "completed", callPath: [] }] } as unknown as CanvasSnapshot} selected="impl" selectedPhase="first" onSelect={() => {}} />);
  expect(screen.getByRole("button", { name: "实现，已完成" })).toHaveClass("selected");
  expect(screen.getByRole("button", { name: "实现，未触发" })).not.toHaveClass("selected");
});

it("draws actual action dependency edges and selects their underlying phase", () => {
  const dag: HierarchyStructure = { rootFlow: "main", flows: { main: { id: "main", label: "主流程", entry: "work", phases: [{
    id: "work", run: ["impl", "a", "b", "fix"], edges: [{ from: "impl", to: "a" }, { from: "impl", to: "b" }, { from: "a", to: "fix" }], routes: [{ next: "$complete", conditional: false }],
  }] } } };
  const select = vi.fn();
  const { container } = render(<WorkflowHierarchy entry="work" structure={dag} nodes={nodes} snapshot={{ runId: "run-1", active: true, run: { runId: "run-1", name: "", status: "running", args: null, result: null, failure: null }, execution: { phase: "work", stack: [], calls: [] }, retries: [], hasLease: true, catalog: null, nodes: [{ siteId: "impl", phaseId: "work", ordinal: 1, status: "completed", callPath: [] }, { siteId: "a", phaseId: "work", ordinal: 1, status: "running", callPath: [] }, { siteId: "b", phaseId: "work", ordinal: 1, status: "running", callPath: [] }] } as unknown as CanvasSnapshot} selected="" onSelect={select} />);
  expect(screen.getByRole("button", { name: "实现，已完成" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "处置，未触发" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reviewer A，运行中" }));
  expect(select).toHaveBeenCalledWith("a", [], "work");
  const from = JSON.stringify(["node", "work", "impl"]);
  const to = JSON.stringify(["node", "work", "a"]);
  expect(Array.from(container.querySelectorAll("svg[aria-label='执行关系'] g")).some((g) => g.getAttribute("data-from") === from && g.getAttribute("data-to") === to)).toBe(true);
});

it("places a join below the longest incoming branch", () => {
  const dag: HierarchyStructure = { rootFlow: "main", flows: { main: { id: "main", label: "主流程", entry: "work", phases: [{ id: "work", run: ["impl", "a", "b", "fix", "scan"], edges: [{ from: "impl", to: "a" }, { from: "impl", to: "b" }, { from: "a", to: "fix" }, { from: "fix", to: "scan" }, { from: "b", to: "scan" }], routes: [{ next: "$complete", conditional: false }] }] } } };
  render(<WorkflowHierarchy entry="work" structure={dag} nodes={nodes} snapshot={null} selected="" onSelect={() => {}} />);
  // 纵向画布：行序自上而下，汇合点排在最长入边分支之后（更靠下）。
  const top = (name: string) => parseInt(screen.getByRole("region", { name }).style.top, 10);
  expect(top("检查")).toBeGreaterThan(top("处置"));
  expect(top("检查")).toBeGreaterThan(top("Reviewer B"));
  // 同秩的并行分支并排：Reviewer A 与 Reviewer B 在同一行。
  expect(top("Reviewer A")).toBe(top("Reviewer B"));
});

it("opens an actual subflow node connected in a dependency graph", () => {
  const callSite = JSON.stringify(["node", "work", "sub"]);
  const callId = `${callSite}@1`;
  const graph: HierarchyStructure = { rootFlow: "main", flows: {
    main: { id: "main", label: "主流程", entry: "work", phases: [{ id: "work", run: ["impl", "sub", "scan"], edges: [{ from: "impl", to: "sub" }, { from: "sub", to: "scan" }], routes: [{ next: "$complete", conditional: false }] }] },
    child: { id: "child", label: "子流程内容", entry: "child-work", phases: [{ id: "child-work", run: ["a"], routes: [{ next: "$return", conditional: false }] }] },
  } };
  const graphNodes = [...nodes, { id: "sub", label: "独立子流程", kind: "flow", call: "child", steps: [] }] as unknown as WorkflowCatalogNode[];
  const graphSnapshot = { runId: "run-1", active: true, run: { runId: "run-1", name: "", status: "running", args: null, result: null, failure: null }, execution: { phase: "work", stack: [], calls: [{ id: callId, phase: callSite, flow: "child", ordinal: 1, parent: null, status: "running", scope: {} }] }, retries: [], hasLease: true, catalog: null, nodes: [{ siteId: "a", phaseId: "child-work", ordinal: 1, status: "running", callPath: [callId] }] } as unknown as CanvasSnapshot;
  const { container } = render(<WorkflowHierarchy entry="work" structure={graph} nodes={graphNodes} snapshot={graphSnapshot} selected="" onSelect={() => {}} />);
  expect(screen.getByRole("region", { name: "独立子流程" })).toHaveTextContent("运行中");
  expect(Array.from(container.querySelectorAll("svg[aria-label='执行关系'] g")).some((g) => g.getAttribute("data-to") === callSite)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "进入子流程 ›" }));
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
});

it("shows a later skipped subflow call instead of its older completion", () => {
  const callSite = JSON.stringify(["node", "work", "sub"]);
  const callId = `${callSite}@1`;
  const graph: HierarchyStructure = { rootFlow: "main", flows: { main: { id: "main", label: "主流程", entry: "work", phases: [{ id: "work", run: ["impl", "sub"], edges: [{ from: "impl", to: "sub", when: { path: "/latest/impl/selected" } }], routes: [{ next: "$complete", conditional: false }] }] }, child: { id: "child", label: "子流程内容", entry: "child-work", phases: [{ id: "child-work", run: ["a"], routes: [{ next: "$return", conditional: false }] }] } } };
  const graphNodes = [...nodes, { id: "sub", label: "独立子流程", kind: "flow", call: "child", steps: [] }] as unknown as WorkflowCatalogNode[];
  const graphSnapshot = { runId: "run-1", active: false, run: { runId: "run-1", name: "", status: "completed", args: null, result: null, failure: null }, execution: { phase: "work", stack: [], calls: [{ id: callId, phase: callSite, flow: "child", ordinal: 1, parent: null, status: "completed", scope: {} }] }, retries: [], hasLease: false, catalog: null, nodes: [{ siteId: "sub", phaseId: "work", ordinal: 2, status: "skipped", callPath: [] }] } as unknown as CanvasSnapshot;
  const { container } = render(<WorkflowHierarchy entry="work" structure={graph} nodes={graphNodes} snapshot={graphSnapshot} selected="" onSelect={() => {}} />);
  expect(screen.getByRole("region", { name: "独立子流程" })).toHaveTextContent("已跳过");
  // 条件边用虚线表达，不再给每条条件边贴通用「条件」字样（作者标签照常显示）。
  const conditional = Array.from(container.querySelectorAll("svg[aria-label='执行关系'] g[data-conditional='true']"));
  expect(conditional.length).toBeGreaterThan(0);
  expect(screen.queryByText("条件")).not.toBeInTheDocument();
});

it("navigates from an active session into a subflow node on the graph", () => {
  const callSite = JSON.stringify(["node", "work", "sub"]);
  const callId = `${callSite}@1`;
  const graph: HierarchyStructure = { rootFlow: "main", flows: { main: { id: "main", label: "主流程", entry: "work", phases: [{ id: "work", run: ["impl", "sub"], edges: [{ from: "impl", to: "sub" }], routes: [{ next: "$complete", conditional: false }] }] }, child: { id: "child", label: "子流程内容", entry: "child-work", phases: [{ id: "child-work", run: ["a"], routes: [{ next: "$return", conditional: false }] }] } } };
  const graphNodes = [...nodes, { id: "sub", label: "独立子流程", kind: "flow", call: "child", steps: [] }] as unknown as WorkflowCatalogNode[];
  const graphSnapshot = { runId: "run-1", active: true, run: { runId: "run-1", name: "", status: "running", args: null, result: null, failure: null }, execution: { phase: "work", stack: [], calls: [{ id: callId, phase: callSite, flow: "child", ordinal: 1, parent: null, status: "running", scope: {} }] }, retries: [], hasLease: true, catalog: null, nodes: [{ siteId: "a", phaseId: "child-work", ordinal: 1, status: "running", callPath: [callId] }] } as unknown as CanvasSnapshot;
  render(<WorkflowHierarchy entry="work" structure={graph} nodes={graphNodes} snapshot={graphSnapshot} selected="" runningSite="a" onSelect={() => {}} />);
  expect(within(screen.getByLabelText("子流程路径")).getByRole("button", { name: "子流程内容" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reviewer A，运行中" })).toBeInTheDocument();
});
