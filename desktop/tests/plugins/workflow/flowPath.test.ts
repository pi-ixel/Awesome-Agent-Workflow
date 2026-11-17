import { expect, it } from "vitest";
import type { HierarchyStructure, WorkflowCatalogNode } from "../../../src/plugins/workflow/types.ts";
import {
  expandDependencies,
  flowStepCount,
  flowTree,
  framesOf,
  jumpFrame,
  popFrame,
  pushFrame,
  reachable,
  type Frame,
} from "../../../src/plugins/workflow/ui/flowPath.ts";

/**
 * 层级路径：下钻进子流程、返回、跳到任意层，以及子流程树。
 * 从前这块嵌在画布组件里，右上角的流程导航够不着它。
 */
const structure: HierarchyStructure = {
  rootFlow: "main",
  flows: {
    main: { id: "main", label: "主流程", entry: "start", phases: [
      { id: "start", run: ["impl"], routes: [{ next: "review", conditional: false }] },
      { id: "review", run: [], call: "check", routes: [{ next: "$complete", conditional: false }] },
    ] },
    check: { id: "check", label: "独立检查", entry: "inspect", phases: [
      { id: "inspect", run: ["gate"], routes: [{ next: "deep", conditional: false }] },
      { id: "deep", run: [], call: "gate-flow", routes: [{ next: "$return", conditional: false }] },
    ] },
    "gate-flow": { id: "gate-flow", label: "自动门禁", entry: "unit", phases: [
      { id: "unit", run: ["test"], routes: [{ next: "$return", conditional: false }] },
    ] },
  },
};
const nodes = [
  { id: "impl", label: "实现", kind: "agent", steps: [] },
  { id: "gate", label: "检查", kind: "agent", steps: [] },
  { id: "test", label: "单测", kind: "python", steps: [] },
] as unknown as WorkflowCatalogNode[];
const nodeMap = new Map(nodes.map((node) => [node.id, node]));

it("counts the steps inside a subflow so the card can say 子工作流 · N 步", () => {
  expect(flowStepCount(structure.flows.check)).toBe(2);
  expect(flowStepCount(structure.flows["gate-flow"])).toBe(1);
  expect(flowStepCount(undefined)).toBe(0);
});

it("builds the nesting tree down to the deepest level, with the phase that opens each layer", () => {
  const [root] = flowTree(structure, "start");
  expect(root).toMatchObject({ flow: "main", label: "主流程", stepCount: 2 });
  const check = root?.children[0];
  expect(check).toMatchObject({ flow: "check", label: "独立检查", via: "review", stepCount: 2 });
  // L3 也在树里：不必先点进 L2 才知道它存在。
  expect(check?.children[0]).toMatchObject({ flow: "gate-flow", via: "deep", stepCount: 1 });
});

it("does not loop when a subflow calls back into an ancestor", () => {
  const cyclic: HierarchyStructure = { rootFlow: "a", flows: {
    a: { id: "a", label: "A", entry: "s", phases: [{ id: "s", run: [], call: "b", routes: [] }] },
    b: { id: "b", label: "B", entry: "t", phases: [{ id: "t", run: [], call: "a", routes: [] }] },
  } };
  const [root] = flowTree(cyclic, "s");
  expect(root?.children.map((child) => child.flow)).toEqual(["b"]);
  expect(root?.children[0]?.children).toEqual([]);
});

it("steps in, back out, and jumps to any level while reporting the card to refocus", () => {
  const root: Frame = { flow: "main", entry: "start" };
  const l2: Frame = { flow: "check", entry: "inspect", via: "review" };
  const l3: Frame = { flow: "gate-flow", entry: "unit", via: "deep" };
  const path = pushFrame(pushFrame([root], l2), l3);
  expect(popFrame(path)).toEqual({ path: [root, l2], focus: "deep" });
  expect(popFrame([root])).toBeNull();
  // 从 L3 直接回根层：被关掉的是 L2，焦点落回打开 L2 的那张卡。
  expect(jumpFrame(path, 0)).toEqual({ path: [root], focus: "review" });
  expect(jumpFrame(path, 2)).toBeNull();
});

it("rebuilds a path from a tree chain and attaches the latest call instance", () => {
  const root = flowTree(structure, "start")[0]!;
  const check = root.children[0]!;
  const frames = framesOf({
    entry: "start",
    chain: [root, check],
    snapshot: { execution: { phase: "review", stack: [], calls: [
      { id: "review@1", phase: "review", flow: "check", ordinal: 1, parent: null, status: "completed", scope: {} },
    ] } } as never,
  });
  expect(frames).toEqual([{ flow: "main", entry: "start" }, { flow: "check", entry: "inspect", via: "review", instanceId: "review@1" }]);
});

it("expands dependency graphs into per-action cells without inventing work", () => {
  const flat: HierarchyStructure["flows"][string] = { id: "work", label: "w", entry: "work", phases: [{
    id: "work", run: ["impl", "gate"], edges: [{ from: "impl", to: "gate" }], routes: [{ next: "$complete", conditional: false }],
  }] };
  const expanded = expandDependencies(flat, "work", nodeMap);
  // 两个动作各占一格，并有作者写的那条依赖边；去向仍是原来的终点。
  expect(expanded.flow.phases.flatMap((phase) => phase.run)).toEqual(["impl", "gate"]);
  expect(expanded.flow.phases[0]?.routes[0]?.next).toBe(JSON.stringify(["node", "work", "gate"]));
  expect(reachable(expanded.flow, expanded.entry)).toHaveLength(2);
});
