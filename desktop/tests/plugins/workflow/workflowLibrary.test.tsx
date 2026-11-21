import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary, workflowSummary, findStep } from "./helpers.ts";
import { renderTemplates } from "./templateHarness.tsx";

/** 模板在左侧功能区（侧栏选分类、中间看库与详情），运行在右侧标签页，发起只从会话来（ADR 038）。 */
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
const category = (name: RegExp) => within(screen.getByRole("region", { name: "工作流分类" })).getByRole("button", { name });

it("keeps templates in the feature area without a run button, and runs in the right panel", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  fake.setRuns([runSummary({ runId: "r1", title: "给 logo 加底座", status: "completed", updatedAt: Date.now() })]);
  renderTemplates(fake.service);
  expect(await within(category(/^预置/)).findByText("1")).toBeInTheDocument();
  expect(category(/^预置/)).toHaveAttribute("aria-current", "true");
  const presets = await screen.findByRole("region", { name: "预置工作流" });
  expect(await within(presets).findByRole("button", { name: "查看工作流 AAW 轻量开发" })).toBeInTheDocument();
  expect(within(presets).queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
  expect(screen.queryByText("给 logo 加底座")).not.toBeInTheDocument();
  fireEvent.click(category(/^我的/));
  expect(within(screen.getByRole("region", { name: "我的工作流" })).getByRole("button", { name: "查看工作流 my-flow" })).toBeInTheDocument();
  cleanup();
  // 右侧标签页：最近的运行顺利结束了，就落在运行管理；这里没有工作流库。
  render(<WorkflowPanel service={fake.service} />);
  const runs = await screen.findByRole("region", { name: "运行管理" });
  expect(within(runs).getByRole("button", { name: "查看运行 给 logo 加底座" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "工作流库" })).not.toBeInTheDocument();
});

it("keeps the chosen category after going into a workflow and back", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  renderTemplates(fake.service);
  fireEvent.click(category(/^我的/));
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 my-flow" }));
  fireEvent.click(await screen.findByRole("button", { name: "工作流库" }));
  expect(await screen.findByRole("region", { name: "我的工作流" })).toBeInTheDocument();
  expect(category(/^我的/)).toHaveAttribute("aria-current", "true");
});

it("places runs needing confirmation in their own section above the running and completed records", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([
    runSummary({ runId: "done", title: "已经跑完", workflowId: "other", name: "AAW 完整开发", status: "completed", updatedAt: Date.now() }),
    runSummary({ runId: "wait", title: "等你确认需求", status: "waiting", updatedAt: Date.now() }),
  ]);
  render(<WorkflowPanel service={fake.service} />);
  const panel = await screen.findByRole("region", { name: "运行管理" });
  const pending = within(panel).getByRole("region", { name: "待处理" });
  const history = within(panel).getByRole("region", { name: "运行记录" });
  expect(within(pending).getByRole("button", { name: "查看运行 等你确认需求" })).toBeInTheDocument();
  expect(within(history).queryByRole("button", { name: "查看运行 等你确认需求" })).not.toBeInTheDocument();
  // 状态是行首的图标，悬停给出状态词。
  expect(within(history).getByRole("button", { name: "查看运行 已经跑完" }).querySelector(".workflow-run-mark.tone-completed")).toHaveAttribute("data-hint", "已完成");
});

it("numbers repeat runs of one workflow, and writes the workflow name only when it changes", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([
    runSummary({ runId: "a3", title: "写入并检查 hello.txt", status: "completed", createdAt: 30, updatedAt: 30 }),
    runSummary({ runId: "a2", title: "写入并检查 hello.txt", status: "completed", createdAt: 25, updatedAt: 25 }),
    runSummary({ runId: "a1", title: "写入并检查 hello.txt", status: "completed", createdAt: 10, updatedAt: 10 }),
    runSummary({ runId: "b1", title: "读文件并统计字数", workflowId: "other", name: "Python 转 Java", status: "completed", createdAt: 20, updatedAt: 20 }),
  ]);
  render(<WorkflowPanel service={fake.service} />);
  const panel = await screen.findByRole("region", { name: "运行管理" });
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 3 次" })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 2 次" })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 1 次" })).toBeInTheDocument();
  // 相邻三行同属一个工作流，工作流名只写在第一行的副行里；起点都一样，不写起点。
  const metas = [...panel.querySelectorAll(".workflow-run-list-meta")];
  expect(metas.some((meta) => meta.textContent?.includes("从头开始"))).toBe(false);
  expect(metas.filter((meta) => meta.textContent?.startsWith("AAW 轻量开发"))).toHaveLength(1);
  expect(metas.filter((meta) => meta.textContent?.startsWith("Python 转 Java"))).toHaveLength(1);
});

it("lists all runs directly in run management", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns(Array.from({ length: 7 }, (_, index) => runSummary({ runId: `r${index}`, title: `运行 ${index}`, status: "completed", createdAt: index, updatedAt: index })));
  render(<WorkflowPanel service={fake.service} />);
  const panel = await screen.findByRole("region", { name: "运行管理" });
  expect(within(panel).getAllByRole("button", { name: /^查看运行/ })).toHaveLength(7);
});

it("shows a broken workflow with its first compile error", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([{ id: "broken", origin: "user", meta: null, diagnostics: [{ severity: "error", file: "flows/main.yaml", line: 12, path: "steps.a.next[0]", message: "去向「x」不是本流程里的步骤" }] }]);
  renderTemplates(fake.service);
  fireEvent.click(category(/^我的/));
  expect(await screen.findByText(/flows\/main\.yaml:12（steps\.a\.next\[0\]）：去向「x」不是本流程里的步骤/)).toBeInTheDocument();
});

it("goes from the library to the workflow and previews its graph and source, with nothing to launch there", async () => {
  const fake = fakeWorkflowService();
  fake.setDetail({ ...workflowSummary(), catalogs: { dev: catalog }, files: [{ path: "workflow.yaml", text: "id: aaw-dev" }, { path: "flows/main.yaml", text: "label: dev" }], scripts: [] });
  renderTemplates(fake.service);
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 AAW 轻量开发" }));
  expect(screen.getByRole("navigation", { name: "位置" })).toHaveTextContent(/^工作流库/);
  // 流程图预览：卡片上写着这一步做什么；点开在分屏里审查它。
  fireEvent.click(await findStep("需求确认"));
  const review = screen.getByRole("complementary", { name: "节点说明" });
  expect(within(review).getByRole("region", { name: "做什么" })).toHaveTextContent("确认需求与边界");
  expect(within(screen.getByRole("button", { name: "需求确认" })).getByText("确认需求与边界")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /源码/ }));
  fireEvent.click(screen.getByRole("button", { name: "flows/main.yaml" }));
  expect(screen.getByLabelText("flows/main.yaml")).toHaveTextContent("label: dev");
  expect(screen.queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /运行/ })).not.toBeInTheDocument();
});

it("runs again from the run page through a new session, never a form", async () => {
  const fake = fakeWorkflowService();
  const again = vi.fn();
  fake.setRuns([runSummary({ runId: "r2", title: "中断的运行", status: "stopped" })]);
  render(<WorkflowPanel service={fake.service} onRunAgain={again} />);
  await vi.waitFor(() => expect(crumb()).toBe("中断的运行"));
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "再次运行" }));
  expect(again).toHaveBeenCalledWith("r2");
  expect(screen.queryByRole("region", { name: /^启动 / })).not.toBeInTheDocument();
});

it("copies a preset as mine and opens the copy", async () => {
  const fake = fakeWorkflowService();
  renderTemplates(fake.service);
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 AAW 轻量开发" }));
  fake.setLibrary([workflowSummary(), workflowSummary("aaw-dev-copy", "user")]);
  fireEvent.click(await screen.findByRole("button", { name: "更多" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "复制为我的" }));
  await vi.waitFor(() => expect(fake.calls.some((call) => call.method === "copyWorkflow" && call.args === "aaw-dev")).toBe(true));
  await vi.waitFor(() => expect(category(/^我的/)).toHaveAttribute("aria-current", "true"));
  expect(await screen.findByText("aaw-dev-copy", { selector: ".workflow-detail-title b" })).toBeInTheDocument();
});

it("lands on the latest run when it has not finished cleanly", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([runSummary({ runId: "r2", title: "中断的运行", status: "stopped" }), runSummary({ runId: "r1", status: "completed" })]);
  render(<WorkflowPanel service={fake.service} />);
  await vi.waitFor(() => expect(crumb()).toBe("中断的运行"));
});

it("deletes one of my workflows from its card after confirming, presets have no delete", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("mine", "user")]);
  renderTemplates(fake.service);
  expect(await screen.findByRole("button", { name: /查看工作流 AAW 轻量开发/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除工作流" })).not.toBeInTheDocument();
  fireEvent.click(category(/^我的/));
  const card = (await screen.findByRole("button", { name: "查看工作流 mine" })).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "删除工作流" }));
  fireEvent.click(within(card).getByRole("button", { name: "确认删除工作流" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "deleteWorkflow", args: "mine" }));
});
