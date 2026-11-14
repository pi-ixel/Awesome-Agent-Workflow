/**
 * 节点检视器：结果按字段规律解读（结论 / 问题 / 产出文件 / 其余字段），
 * 未执行节点讲「会做什么、什么时候执行」，原始 JSON 只折叠兜底；面板宽度
 * 决定检视器在右侧还是下方。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import { describeResult, tidyText, entryConditions, looksLikePath } from "../../../src/plugins/workflow/ui/nodeDetail.ts";
import type { CanvasSnapshot, RunSummary, WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary } from "./helpers.ts";

const catalog: WorkflowCatalog = {
  id: "aaw-dev", name: "AAW dev", revision: "r1", entry: "design",
  nodes: [
    { id: "ask#1", label: "设计", kind: "agent", steps: ["验证项目事实", "形成设计"] },
    { id: "ask#2", label: "设计检查", kind: "agent", steps: ["检查设计和证据"] },
    { id: "ask#3", label: "修正设计", kind: "agent", steps: ["修复可安全修正的问题", "产出新版本"] },
  ],
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "dev", entry: "design", phases: [
    { id: "design", run: ["ask#1"], routes: [{ next: "review", conditional: false }] },
    { id: "review", run: ["ask#2"], routes: [{ next: "repair", conditional: true, label: "可修正" }, { next: "$complete", conditional: false }] },
    { id: "repair", run: ["ask#3"], routes: [{ next: "review", conditional: false }] },
  ] } } },
};
const run: RunSummary = runSummary({ runId: "run-1", name: "AAW dev", status: "running", args: { workflowId: "aaw-dev", workflowRevision: "r1" } });
const record = (siteId: string, phaseId: string, status: string, result: unknown = null) => ({
  siteId, phaseId, kind: "ask", ordinal: 1, status, actorSiteId: "", actorOrdinal: 0, callPath: [], scope: {}, result, candidates: [],
});

function mount(nodes: unknown[], props: { onOpenFile?: (path: string) => void } = {}) {
  const fake = fakeWorkflowService();
  fake.setRuns([run]);
  fake.setSnapshot("run-1", { runId: "run-1", run, catalog, execution: null, active: true, hasLease: true, retries: [], actors: [], nodes } as unknown as CanvasSnapshot);
  render(<WorkflowPanel service={fake.service} {...props} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reads a review result as a verdict, issues, files and facts instead of raw JSON", () => {
  const view = describeResult({ decision: "revise", issues: "1. 缺少回滚方案\n2. 接口未定义错误码", report: ".aaw/review/design-check.md", safe: true });
  expect(view?.conclusion).toEqual({ text: "需修正", tone: "warn" });
  expect(view?.issues).toEqual(["缺少回滚方案", "接口未定义错误码"]);
  expect(view?.files).toEqual([{ label: "报告", path: ".aaw/review/design-check.md" }]);
  expect(view?.facts).toEqual([{ label: "可安全修正", value: "是" }]);
});

it("collects file maps and path arrays, lists object arrays, and keeps unknown fields by name", () => {
  const view = describeResult({
    status: "ready",
    files: { "docs/design.md": "设计稿", api: "docs/api.yaml" },
    tasks: [{ id: "T1", goal: "实现登录" }, { id: "T2", goal: "补测试" }],
    evidence: "已对照 src/auth 下现有实现逐个核对了登录、登出和令牌刷新三条路径，并运行了全部单测与集成测试，确认设计与现状一致，没有遗漏的调用方，也没有需要迁移的历史数据。",
    customFlag: "x",
  });
  expect(view?.conclusion?.text).toBe("已完成");
  expect(view?.files).toEqual([{ label: "设计稿", path: "docs/design.md" }, { label: "api", path: "docs/api.yaml" }]);
  expect(view?.lists).toEqual([{ label: "任务", items: ["T1 · 实现登录", "T2 · 补测试"] }]);
  expect(view?.texts[0]?.label).toBe("依据");
  expect(view?.facts).toEqual([{ label: "customFlag", value: "x" }]);
  expect(describeResult(null)).toBeNull();
});

it("only treats whitespace-free, path-shaped strings as files", () => {
  expect(looksLikePath(".aaw/plan.md")).toBe(true);
  expect(looksLikePath("D:\\work\\report.md")).toBe(true);
  expect(looksLikePath("report.md")).toBe(true);
  expect(looksLikePath("pass")).toBe(false);
  expect(looksLikePath("见 docs/a.md 第二节")).toBe(false);
  expect(looksLikePath("https://example.com/a.md")).toBe(false);
  expect(looksLikePath("1.5")).toBe(false);
});

it("derives when a node runs from the routes pointing at its phase, with author labels", () => {
  const label = (site: string) => catalog.nodes.find((node) => node.id === site)?.label ?? site;
  expect(entryConditions(catalog.structure!, "ask#3", "repair", label)).toEqual(["「设计检查」之后 · 可修正"]);
  expect(entryConditions(catalog.structure!, "ask#1", undefined, label)).toEqual(["流程开始时执行"]);
  expect(entryConditions(catalog.structure!, "ask#2", "review", label)).toEqual(["「设计」之后", "「修正设计」之后"]);
});

it("shows a finished node's verdict and openable files, with the raw result folded", async () => {
  const onOpenFile = vi.fn();
  mount([record("ask#2", "review", "completed", { decision: "revise", issues: "缺少回滚方案", report: ".aaw/review.md", safe: true })], { onOpenFile });
  fireEvent.click(await screen.findByRole("button", { name: /^设计检查，/ }));
  const inspector = screen.getByRole("complementary", { name: "节点详情" });
  expect(within(inspector).getByText("需修正")).toBeInTheDocument();
  expect(within(inspector).getByText("缺少回滚方案")).toBeInTheDocument();
  fireEvent.click(within(inspector).getByRole("button", { name: ".aaw/review.md" }));
  expect(onOpenFile).toHaveBeenCalledWith(".aaw/review.md");
  const raw = within(inspector).getByText("原始结果").closest("details");
  expect(raw).not.toHaveAttribute("open");
  expect(within(inspector).queryByRole("tab")).not.toBeInTheDocument();
});

it("tells what a not-yet-run node will do and when it runs", async () => {
  mount([record("ask#1", "design", "running")]);
  fireEvent.click(await screen.findByRole("button", { name: "修正设计，未触发" }));
  const inspector = screen.getByRole("complementary", { name: "节点详情" });
  expect(within(inspector).getByText("这个节点会做")).toBeInTheDocument();
  expect(within(inspector).getByText("修复可安全修正的问题")).toBeInTheDocument();
  expect(within(inspector).getByText("「设计检查」之后 · 可修正")).toBeInTheDocument();
  expect(within(inspector).queryByText("原始结果")).not.toBeInTheDocument();
});

it("shows the steps of a running node rather than an empty output", async () => {
  mount([record("ask#1", "design", "running")]);
  fireEvent.click(await screen.findByRole("button", { name: "设计，运行中" }));
  const inspector = screen.getByRole("complementary", { name: "节点详情" });
  expect(within(inspector).getByText("这一步要做")).toBeInTheDocument();
  expect(within(inspector).getByText("验证项目事实")).toBeInTheDocument();
  expect(within(inspector).queryByText("什么时候执行")).not.toBeInTheDocument();
});

it("puts the inspector beside the canvas on a wide panel and below it on a narrow one", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(820);
  mount([record("ask#1", "design", "running")]);
  fireEvent.click(await screen.findByRole("button", { name: "设计，运行中" }));
  expect(screen.getByRole("complementary", { name: "节点详情" }).parentElement).toHaveClass("is-wide");
  cleanup();
  width.mockReturnValue(520);
  mount([record("ask#1", "design", "running")]);
  fireEvent.click(await screen.findByRole("button", { name: "设计，运行中" }));
  expect(screen.getByRole("complementary", { name: "节点详情" }).parentElement).toHaveClass("is-stacked");
});

it("uses the labels written in the workflow definition before guessing from field names", () => {
  const labels = { decision: "结论", "decision.revise": "要改设计", report: "评审报告", risk_level: "风险等级" };
  const view = describeResult({ decision: "revise", report: ".aaw/review.md", risk_level: "高", unknown_key: "x" }, labels);
  expect(view?.conclusion).toEqual({ text: "要改设计", tone: "warn" });
  expect(view?.files).toEqual([{ label: "评审报告", path: ".aaw/review.md" }]);
  expect(view?.facts).toEqual([{ label: "风险等级", value: "高" }, { label: "unknown_key", value: "x" }]);
  // 没写 labels 时照旧按字段名推断。
  expect(describeResult({ decision: "revise", report: ".aaw/review.md" })?.files[0]?.label).toBe("报告");
});

it("turns pinned artifacts into their source files, once each, under the author's name", () => {
  const uri = "workflow-artifact://c22cdf54-174a-43b8-96ea-74b80c9fe4d7";
  const view = describeResult(
    { status: "ready", design_doc_uri: uri, design: uri, lost: "workflow-artifact://gone" },
    { design: "设计文档" },
    { [uri]: String.raw`\\?\C:\work\design.md` },
  );
  expect(view?.files).toEqual([{ label: "设计文档", path: String.raw`C:\work\design.md` }]);
  // 找不到来源的快照不当文件，也不把内部地址列给人看。
  expect(JSON.stringify(view)).not.toContain("workflow-artifact://gone");
});

it("reads result text without snapshot addresses or hashes, one numbered point per line", () => {
  const uri = "workflow-artifact://d62e57cb-ed70-449c-b227-8be39c6e0d1f";
  const text = tidyText(`任务计划：${uri}（SHA-256 f7738b28d0576acd），本地位置 overview.md。1) 单元测试通过；2) 目录外零改动`, { [uri]: "trial/aaw-e2e/overview.md" });
  expect(text).toBe("任务计划：overview.md，本地位置 overview.md。\n1) 单元测试通过；\n2) 目录外零改动");
});
