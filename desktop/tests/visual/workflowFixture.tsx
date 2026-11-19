/**
 * 流程画布的真机同源夹具：直接渲染产品里的 FlowStages，
 * 结构与 aaw-dev 的 main/task 流程一致（含条件轨道、回环、子流程调用、终点）。
 *
 * 用途：在浏览器里以真实 CSS 与真实字号复核画布外观（托盘层级、卡片、叠板、
 * 导轨、缩放药丸）。这里只搭数据，不复刻样式。
 */
import { createRoot } from "react-dom/client";
import "../../src/shared/styles/index.css";
import "../../src/plugins/workflow/ui/workflowPanel.css";
import { FlowStages } from "../../src/plugins/workflow/ui/FlowStages.tsx";
import { WorkflowPanel } from "../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import { fakeWorkflowService, runSummary } from "../plugins/workflow/helpers.ts";
import type {
  CanvasSnapshot,
  HierarchyStructure,
  WorkflowCatalogNode,
  WorkflowStage,
} from "../../src/plugins/workflow/types.ts";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.remove("theme-warm");

const stages: WorkflowStage[] = [
  { id: "design", label: "设计" },
  { id: "task", label: "任务开发" },
  { id: "delivery", label: "交付" },
];

const structure: HierarchyStructure = {
  rootFlow: "main",
  flows: {
    main: {
      id: "main",
      label: "dev 工作流",
      entry: "requirement",
      phases: [
        { id: "requirement", stage: "design", run: ["requirement"], routes: [{ next: "design", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "design", stage: "design", run: ["design"], routes: [{ next: "design_review", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "design_review", stage: "design", run: ["design_review"], routes: [{ next: "design_repair", label: "可修正", conditional: true }, { next: "tests", label: "通过", conditional: true }, { next: "$blocked", conditional: false }] },
        { id: "design_repair", stage: "design", run: ["design_repair"], routes: [{ next: "design_recheck", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "design_recheck", stage: "design", run: ["design_recheck"], routes: [{ next: "design_repair", label: "可修正", conditional: true }, { next: "tests", label: "通过", conditional: true }, { next: "$blocked", conditional: false }] },
        { id: "tests", stage: "design", run: ["tests"], routes: [{ next: "gate", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "gate", stage: "design", run: ["gate"], routes: [{ next: "gate_repair", label: "可修正", conditional: true }, { next: "plan", label: "通过", conditional: true }, { next: "$blocked", conditional: false }] },
        { id: "gate_repair", stage: "design", run: ["gate_repair"], routes: [{ next: "gate_recheck", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "gate_recheck", stage: "design", run: ["gate_recheck"], routes: [{ next: "gate_repair", label: "可修正", conditional: true }, { next: "plan", label: "通过", conditional: true }, { next: "$blocked", conditional: false }] },
        { id: "plan", stage: "task", run: ["plan"], routes: [{ next: "task_call", label: "确认计划后开发", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "task_call", stage: "task", run: [], call: "task", callEntry: "implementation", foreach: { maxConcurrency: 1 }, routes: [{ next: "final", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "final", stage: "delivery", run: ["final"], routes: [{ next: "$complete", label: "确认交付", conditional: false }, { next: "$blocked", conditional: false }] },
      ],
    },
    task: {
      id: "task",
      label: "任务开发",
      entry: "implementation",
      phases: [
        { id: "implementation", stage: "task", run: ["implementation"], routes: [{ next: "scan", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "scan", stage: "task", run: ["scan"], routes: [{ next: "delivery", label: "通过", conditional: true }, { next: "scan_repair", label: "可修正", conditional: true }, { next: "$blocked", conditional: false }] },
        { id: "scan_repair", stage: "task", run: ["scan_repair"], routes: [{ next: "scan", conditional: false }, { next: "$blocked", conditional: false }] },
        { id: "delivery", stage: "delivery", run: ["delivery"], routes: [{ next: "$return", conditional: false }] },
        { id: "review_call", stage: "task", run: [], call: "review", routes: [{ next: "scan", conditional: false }] },
      ],
    },
  },
};

const nodes: WorkflowCatalogNode[] = [
  { id: "requirement", label: "需求确认", kind: "agent", steps: ["确认需求与边界", "必要时与用户沟通"] },
  { id: "design", label: "设计", kind: "agent", steps: ["查证项目与问题池", "形成设计并自检"], role: "设计" },
  { id: "design_review", label: "独立设计检查", kind: "agent", steps: ["检查设计和证据", "给出检查结论"], role: "设计独立检查" },
  { id: "design_repair", label: "设计修正", kind: "agent", steps: ["修复可安全处理的问题", "保留新版本"], role: "设计" },
  { id: "design_recheck", label: "设计复查", kind: "agent", steps: ["复查修正后设计", "最多两轮修正"], role: "设计独立检查" },
  { id: "tests", label: "测试设计", kind: "agent", steps: ["规划测试与追溯", "记录设计缺口"] },
  { id: "gate", label: "设计门禁", kind: "agent", steps: ["检查需求与设计闭环", "决定通过或停止"], role: "设计门禁检查" },
  { id: "gate_repair", label: "门禁整改", kind: "agent", steps: ["整改安全问题", "更新产物引用"], role: "设计门禁整改" },
  { id: "gate_recheck", label: "门禁复查", kind: "agent", steps: ["审查更新后的产物", "最多两轮整改"], role: "设计门禁检查" },
  { id: "plan", label: "任务规划", kind: "agent", steps: ["拆分有序任务", "明确范围与测试"] },
  { id: "final", label: "最终交接", kind: "agent", steps: ["汇总验证与产物", "说明遗留问题"] },
  { id: "implementation", label: "实现与测试", kind: "agent", steps: ["实现当前任务", "执行验证并留证"], role: "任务实现与测试" },
  { id: "scan", label: "代码检查", kind: "python", steps: ["用可用的检查工具或自行审读变更", "给出结论与问题清单"] },
  { id: "scan_repair", label: "代码检查整改", kind: "agent", steps: ["修复确定安全的问题", "重新执行检查"], role: "代码检查整改" },
  { id: "delivery", label: "任务交付", kind: "agent", steps: ["核对任务证据", "更新计划与测试版本"] },
];

/** 跑到「设计」这一步：前面已完成，设计在跑，后面未触发。 */
const snapshot = {
  runId: "run-fixture",
  active: true,
  run: { runId: "run-fixture", name: "dev 工作流", status: "running", args: null, result: null, failure: null },
  execution: { phase: "design", stack: [], calls: [] },
  retries: [],
  hasLease: true,
  catalog: null,
  gates: [],
  nodes: [
    { siteId: "requirement", phaseId: "requirement", ordinal: 1, status: "completed", callPath: [] },
    { siteId: "design", phaseId: "design", ordinal: 1, status: "running", callPath: [] },
  ],
} as unknown as CanvasSnapshot;

const root = createRoot(document.querySelector("#root")!);
if (params.has("inspector")) {
  const service = fakeWorkflowService();
  const run = runSummary({ runId: snapshot.runId, title: "流程画布排版验证" });
  const label = "检查工作流节点的长标题和大字号在窄面板中的显示表现";
  service.setRuns([run]);
  service.setSnapshot(run.runId, {
    ...snapshot,
    run,
    catalog: {
      id: "aaw-dev", name: "dev 工作流", revision: "r1", entry: "requirement", structure, stages,
      nodes: nodes.map((node) => node.id === "design" ? { ...node, label } : node),
    },
    actors: [],
    nodes: Array.from({ length: 18 }, (_, index) => ({
      siteId: "design", phaseId: "design", ordinal: index + 1, kind: "ask",
      status: index < 17 ? "completed" : "running",
      scope: {}, callPath: [], actorSiteId: "设计", actorOrdinal: 1,
      result: null, candidates: [], sessionId: `session-${index + 1}`,
    })),
  });
  root.render(<div style={{ height: "100vh" }}>
    <WorkflowPanel service={service.service} onOpenSession={(id) => { document.documentElement.dataset.openedSession = id; }} />
  </div>);
} else if (params.has("panel")) {
  const service = fakeWorkflowService();
  service.setRuns([
    runSummary({ runId: "done", title: "整理交接记录", status: "completed" }),
    runSummary({ runId: "pending", title: "确认设计方案", status: "waiting" }),
  ]);
  root.render(<div style={{ height: "100vh" }}>
    <WorkflowPanel service={service.service} />
  </div>);
} else root.render(
  <div className="workflow-panel" style={{ height: "100vh" }}>
    <div className="workflow-workspace is-wide">
      <div className="workflow-viewport-frame">
        <FlowStages
          label="流程画布"
          rootLabel="dev 工作流"
          entry="requirement"
          structure={structure}
          nodes={nodes}
          stages={stages}
          snapshot={snapshot}
          onSelect={() => {}}
        />
      </div>
    </div>
  </div>,
);
