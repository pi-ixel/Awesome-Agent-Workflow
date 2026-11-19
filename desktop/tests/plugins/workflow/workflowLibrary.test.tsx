import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary, workflowSummary, findStep } from "./helpers.ts";

/** 工作流库和运行管理平级，模板详情和运行分别进入。 */
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

it("places the library and run management in the same navigation and keeps templates in the library", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  fake.setRuns([runSummary({ runId: "r1", title: "给 logo 加底座", status: "completed", updatedAt: Date.now() })]);
  render(<WorkflowPanel service={fake.service} />);
  const navigation = screen.getByRole("tablist", { name: "工作流面板" });
  expect(within(navigation).getByRole("tab", { name: "工作流库" })).toHaveAttribute("aria-selected", "true");
  expect(within(navigation).getByRole("tab", { name: "运行管理" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "位置" })).not.toBeInTheDocument();
  // 预置卡片用于查看和发起模板。
  const presets = await screen.findByRole("region", { name: "预置工作流" });
  expect(await within(presets).findByRole("button", { name: "查看工作流 AAW 轻量开发" })).toBeInTheDocument();
  expect(within(presets).getByRole("button", { name: "运行" })).toBeInTheDocument();
  expect(within(presets).queryByText("给 logo 加底座")).not.toBeInTheDocument();
  // 「我的」在库里，运行管理在上一级。
  expect(screen.getByRole("tab", { name: "预置 1" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "我的 1" }));
  expect(within(screen.getByRole("region", { name: "我的工作流" })).getByRole("button", { name: "查看工作流 my-flow" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "运行管理" }));
  expect(within(screen.getByRole("region", { name: "运行管理" })).getByRole("button", { name: "查看运行 给 logo 加底座" })).toBeInTheDocument();
});

it("keeps the chosen tab after going into a workflow and back", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("tab", { name: "我的 1" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 my-flow" }));
  fireEvent.click(await screen.findByRole("button", { name: "工作流库" }));
  expect(await screen.findByRole("tab", { name: "我的 1" })).toHaveAttribute("aria-selected", "true");
});

it("places runs needing confirmation in their own section above the running and completed records", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([
    runSummary({ runId: "done", title: "已经跑完", workflowId: "other", name: "AAW 完整开发", status: "completed", updatedAt: Date.now() }),
    runSummary({ runId: "wait", title: "等你确认需求", status: "waiting", updatedAt: Date.now() }),
  ]);
  render(<WorkflowPanel service={fake.service} />);
  // 提醒点挂在「运行」页签上：切到别的页签也不丢提醒。
  const runTab = await screen.findByRole("tab", { name: "运行管理" });
  expect(runTab.querySelector("[data-dot]")).not.toBeNull();
  fireEvent.click(runTab);
  const panel = screen.getByRole("region", { name: "运行管理" });
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
  fireEvent.click(await screen.findByRole("tab", { name: "运行管理" }));
  const panel = screen.getByRole("region", { name: "运行管理" });
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
  fireEvent.click(await screen.findByRole("tab", { name: "运行管理" }));
  const panel = screen.getByRole("region", { name: "运行管理" });
  expect(within(panel).getAllByRole("button", { name: /^查看运行/ })).toHaveLength(7);
});

it("shows a broken workflow with its first compile error instead of a run button", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([{ id: "broken", origin: "user", meta: null, diagnostics: [{ severity: "error", file: "flows/main.yaml", line: 12, path: "steps.a.next[0]", message: "去向「x」不是本流程里的步骤" }] }]);
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("tab", { name: "我的 1" }));
  expect(await screen.findByText(/flows\/main\.yaml:12（steps\.a\.next\[0\]）：去向「x」不是本流程里的步骤/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
});

it("goes from the library to the workflow, previews its graph and source, then starts a run and lands on it", async () => {
  const fake = fakeWorkflowService();
  fake.setDetail({ ...workflowSummary(), catalogs: { dev: catalog }, files: [{ path: "workflow.yaml", text: "id: aaw-dev" }, { path: "flows/main.yaml", text: "label: dev" }], scripts: [] });
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看工作流 AAW 轻量开发" }));
  // 流程图预览：卡片上写着这一步做什么；点开在分屏里审查它。
  fireEvent.click(await findStep("需求确认"));
  const review = screen.getByRole("complementary", { name: "节点说明" });
  expect(within(review).getByRole("region", { name: "做什么" })).toHaveTextContent("确认需求与边界");
  expect(within(screen.getByRole("button", { name: "需求确认" })).getByText("确认需求与边界")).toBeInTheDocument();
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
  expect(screen.getByRole("navigation", { name: "位置" })).toHaveTextContent(/^AAW 轻量开发运行详情$/);
  // 返回到工作流详情（流程图），详情页不再列运行记录。
  fireEvent.click(screen.getByRole("button", { name: "AAW 轻量开发" }));
  expect(await screen.findByRole("tab", { name: "流程图", selected: true })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /运行/ })).not.toBeInTheDocument();
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
  fake.service.requestPanel({ kind: "launch", launch: { workflowId: "aaw-dev", entry: "dev" } });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("region", { name: "启动 AAW 轻量开发" })).toBeInTheDocument();
});

it("opens the detail from the sidebar without opening the launch form", async () => {
  const fake = fakeWorkflowService();
  fake.service.requestPanel({ kind: "detail", workflowId: "aaw-dev" });
  render(<WorkflowPanel service={fake.service} />);
  expect(screen.getByRole("navigation", { name: "位置" })).toHaveTextContent(/^工作流库模板详情$/);
  expect(await screen.findByText("AAW 轻量开发", { selector: ".workflow-detail-title b" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "启动 AAW 轻量开发" })).not.toBeInTheDocument();
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
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("button", { name: /查看工作流 AAW 轻量开发/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除工作流" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "我的 1" }));
  const card = (await screen.findByRole("button", { name: "查看工作流 mine" })).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "删除工作流" }));
  fireEvent.click(within(card).getByRole("button", { name: "确认删除工作流" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "deleteWorkflow", args: "mine" }));
});
