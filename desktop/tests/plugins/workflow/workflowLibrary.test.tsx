import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary, workflowSummary } from "./helpers.ts";

/** 工作流库 → 工作流 → 运行 三层导航；模板与运行分开呈现。 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const catalog: WorkflowCatalog = {
  id: "aaw-dev", name: "AAW 轻量开发", revision: "r1", entry: "requirement",
  nodes: [{ id: "requirement", label: "需求确认", kind: "agent", steps: ["确认需求与边界"] }],
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "dev", entry: "requirement", phases: [
    { id: "requirement", run: ["requirement"], routes: [{ next: "$complete", conditional: false }] },
  ] } } },
};

const crumb = () => document.querySelector(".workflow-run-name")?.textContent;

it("opens on the library when the latest run finished, listing presets, mine and recent runs", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  fake.setRuns([runSummary({ runId: "r1", title: "给 logo 加底座", status: "completed", updatedAt: Date.now() })]);
  render(<WorkflowPanel service={fake.service} />);
  const presets = await screen.findByRole("region", { name: "预置工作流" });
  expect(await within(presets).findByRole("button", { name: "查看工作流 AAW 轻量开发" })).toBeInTheDocument();
  expect(within(presets).getByText("本项目运行过 1 次 · 最近 刚刚")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "我的工作流" })).getByRole("button", { name: "查看工作流 my-flow" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "最近的运行" })).getByRole("button", { name: "查看运行 给 logo 加底座" })).toBeInTheDocument();
});

it("shows a broken workflow with its first compile error instead of a run button", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([{ id: "broken", origin: "user", meta: null, diagnostics: [{ severity: "error", file: "flows/main.yaml", line: 12, path: "steps.a.next[0]", message: "去向「x」不是本流程里的步骤" }] }]);
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByText(/flows\/main\.yaml:12（steps\.a\.next\[0\]）：去向「x」不是本流程里的步骤/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
});

it("goes from the library to the workflow, previews its graph and source, then starts a run and lands on it", async () => {
  const fake = fakeWorkflowService();
  fake.setDetail({ ...workflowSummary(), catalogs: { dev: catalog }, files: [{ path: "workflow.yaml", text: "id: aaw-dev" }, { path: "flows/main.yaml", text: "label: dev" }], scripts: [] });
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 AAW 轻量开发" }));
  // 流程图预览：节点都未触发，点开能看到它会做什么
  fireEvent.click(await screen.findByRole("button", { name: "需求确认，未触发" }));
  expect(screen.getByText("确认需求与边界")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /源码/ }));
  fireEvent.click(screen.getByRole("button", { name: "flows/main.yaml" }));
  expect(screen.getByLabelText("flows/main.yaml")).toHaveTextContent("label: dev");
  // 启动 → 落到新运行
  fireEvent.click(screen.getByRole("button", { name: "运行" }));
  fireEvent.change(await screen.findByLabelText("本次需求"), { target: { value: "做一件小事" } });
  fake.setRuns([runSummary({ runId: "run-1", title: "做一件小事" })]);
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await vi.waitFor(() => expect(crumb()).toBe("做一件小事"));
  // 运行标题就在页头，面包屑不再重复它。
  expect(screen.getByRole("navigation", { name: "位置" })).toHaveTextContent(/^工作流库AAW 轻量开发$/);
});

it("copies a preset as mine and opens the copy", async () => {
  const fake = fakeWorkflowService();
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 AAW 轻量开发" }));
  fake.setLibrary([workflowSummary(), workflowSummary("aaw-dev-copy", "user")]);
  fireEvent.click(await screen.findByRole("button", { name: "更多" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "复制为我的" }));
  await vi.waitFor(() => expect(fake.calls.some((call) => call.method === "copyWorkflow" && call.args === "aaw-dev")).toBe(true));
  expect(await screen.findByText("我的")).toBeInTheDocument();
});

it("opens the launch form for a workflow asked for from outside the panel", async () => {
  const fake = fakeWorkflowService();
  fake.service.requestLaunch({ workflowId: "aaw-dev", entry: "dev" });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("region", { name: "启动 AAW 轻量开发" })).toBeInTheDocument();
});

it("lands on the latest run when it has not finished cleanly", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([runSummary({ runId: "r2", title: "中断的运行", status: "stopped" }), runSummary({ runId: "r1", status: "completed" })]);
  render(<WorkflowPanel service={fake.service} />);
  await vi.waitFor(() => expect(crumb()).toBe("中断的运行"));
});
