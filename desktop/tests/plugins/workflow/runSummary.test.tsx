import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeRun } from "../../../src/plugins/workflow/ui/runSummary.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { CanvasNodeSnapshot, CanvasSnapshot, RunSummary, WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary } from "./helpers.ts";

const MIN = 60_000;
const catalog: WorkflowCatalog = {
  id: "aaw-dev", name: "AAW dev", revision: "r1", entry: "design",
  nodes: [
    { id: "design", label: "设计", kind: "agent", steps: [], labels: { reference: "设计文档" } },
    { id: "review", label: "设计检查", kind: "agent", steps: [], labels: { "decision.revise": "要改设计", report: "评审报告" } },
    { id: "sub", label: "任务", kind: "flow", steps: [] },
  ],
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "dev", entry: "design", phases: [
    { id: "design", run: ["design"], routes: [{ next: "review", conditional: false }] },
    { id: "review", run: ["review"], routes: [{ next: "$complete", conditional: false }] },
  ] } } },
};
const record = (siteId: string, ordinal: number, extra: Partial<CanvasNodeSnapshot> = {}): CanvasNodeSnapshot => ({
  siteId, ordinal, kind: "ask", status: "completed", scope: {}, callPath: [], phaseId: siteId,
  actorSiteId: "", actorOrdinal: 0, result: null, candidates: [], ...extra,
});
const run: RunSummary = runSummary({ runId: "run-1", name: "AAW dev", title: "登录改造", status: "completed", createdAt: 0, updatedAt: 30 * MIN, args: { workflowId: "aaw-dev", workflowRevision: "r1" } });
const snapshot: CanvasSnapshot = {
  runId: "run-1", run, catalog, execution: null, active: false, hasLease: false, retries: [], actors: [],
  interventions: [{ id: 1, kind: "rewind", createdAt: 1 }, { id: 2, kind: "confirm", createdAt: 2 }],
  nodes: [
    record("design", 1, { result: { status: "ready", reference: "docs/old.md" }, mark: "superseded", startedAt: 0, endedAt: MIN }),
    record("design", 2, { result: { status: "ready", reference: "docs/design.md" }, startedAt: MIN, endedAt: 11 * MIN, waitedMs: 3 * MIN }),
    record("review", 1, { result: { decision: "revise", report: "docs/review.md" }, startedAt: 11 * MIN, endedAt: 15 * MIN }),
    record("review", 2, { result: { decision: "pass", report: "docs/review.md" }, startedAt: 20 * MIN, endedAt: 25 * MIN }),
    record("sub", 1, { kind: "flow" }),
  ],
};

afterEach(cleanup);

describe("运行总结", () => {
  it("概况、各节点和产出文件只按引擎记录陈述", () => {
    const summary = summarizeRun(snapshot, 99 * MIN)!;
    expect(summary).toMatchObject({ title: "登录改造", startedAt: 0, endedAt: 30 * MIN, elapsedMs: 20 * MIN, waitedMs: 3 * MIN, reworks: 1, confirms: 1, superseded: 1 });
    expect(summary.steps.map((step) => [step.label, step.round, step.conclusion?.text, step.elapsedMs])).toEqual([
      ["设计", null, "已完成", 10 * MIN],
      ["设计检查", 1, "要改设计", 4 * MIN],
      ["设计检查", 2, "通过", 5 * MIN],
    ]);
    // 作废那一轮的文件不列；同一路径只列一次。
    expect(summary.files).toEqual([
      { label: "设计文档", path: "docs/design.md", from: "设计" },
      { label: "评审报告", path: "docs/review.md", from: "设计检查" },
    ]);
  });

  it("从运行页打开总结，点节点回到画布并选中它", async () => {
    const fake = fakeWorkflowService();
    fake.setRuns([run]);
    fake.setSnapshot("run-1", snapshot);
    fake.service.focusRun("run-1");
    render(<WorkflowPanel service={fake.service} />);
    fireEvent.click(await screen.findByRole("button", { name: "总结" }));
    const page = screen.getByLabelText("运行总结");
    expect(within(page).getByRole("region", { name: "概况" })).toHaveTextContent("返工1 次");
    expect(within(page).getByRole("region", { name: "各节点" })).toHaveTextContent("另有 1 轮因回退作废");
    expect(within(page).getByRole("region", { name: "产出文件" })).toHaveTextContent("docs/design.md");
    fireEvent.click(within(page).getByRole("button", { name: "设计检查 · 第 1 轮" }));
    expect(screen.queryByLabelText("运行总结")).not.toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "节点详情" })).toHaveTextContent("设计检查");
  });
});
