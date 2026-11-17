import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary, workflowSummary } from "./helpers.ts";

/** 工作流库 → 工作流 → 运行 三层导航；模板与运行分页签呈现。 */
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

it("opens on the library with a real title, presets first, runs and mine on their own tabs", async () => {
  const fake = fakeWorkflowService();
  fake.setLibrary([workflowSummary(), workflowSummary("my-flow", "user")]);
  fake.setRuns([runSummary({ runId: "r1", title: "给 logo 加底座", status: "completed", updatedAt: Date.now() })]);
  render(<WorkflowPanel service={fake.service} />);
  // 库页有标题行；面包屑只有一项，不再渲染。
  expect(await screen.findByRole("heading", { level: 1, name: "工作流库" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "位置" })).not.toBeInTheDocument();
  // 默认停在「预置」页签：卡片第三行说上次结果，而不是只写跑过几次。
  const presets = await screen.findByRole("region", { name: "预置工作流" });
  expect(await within(presets).findByRole("button", { name: "查看工作流 AAW 轻量开发" })).toBeInTheDocument();
  expect(within(presets).getByText(/上次 已完成 · 刚刚/)).toBeInTheDocument();
  expect(within(presets).queryByText(/本项目运行过/)).not.toBeInTheDocument();
  // 「我的」「运行」各自一个页签，不挤在同一屏。
  expect(screen.getByRole("tab", { name: "预置 1" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "我的 1" }));
  expect(within(screen.getByRole("region", { name: "我的工作流" })).getByRole("button", { name: "查看工作流 my-flow" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /运行 1/ }));
  expect(within(screen.getByRole("region", { name: "运行" })).getByRole("button", { name: "查看运行 给 logo 加底座" })).toBeInTheDocument();
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

it("puts the run that waits for you on top and makes 去处理 the only primary action", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([
    runSummary({ runId: "done", title: "已经跑完", workflowId: "other", name: "AAW 完整开发", status: "completed", updatedAt: Date.now() }),
    runSummary({ runId: "wait", title: "等你确认需求", status: "waiting", updatedAt: Date.now() }),
  ]);
  render(<WorkflowPanel service={fake.service} />);
  // 提醒点挂在「运行」页签上：切到别的页签也不丢提醒。
  const runTab = await screen.findByRole("tab", { name: /运行 2/ });
  expect(runTab.querySelector("[data-dot]")).not.toBeNull();
  fireEvent.click(runTab);
  const panel = screen.getByRole("region", { name: "运行" });
  const callout = within(panel).getByLabelText("要你处理的运行");
  expect(callout).toHaveTextContent("1 次运行等你确认");
  expect(callout).toHaveTextContent("等你确认需求");
  expect(within(callout).getByRole("button", { name: "去处理" })).toBeInTheDocument();
  // 待处理的排在列表最前；已完成那行不挂绿徽标。
  const rows = within(panel).getAllByRole("button", { name: /查看运行/ });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["查看运行 等你确认需求", "查看运行 已经跑完"]);
  expect(rows[1]).not.toHaveTextContent("已完成");
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
  fireEvent.click(await screen.findByRole("tab", { name: /运行 4/ }));
  const panel = screen.getByRole("region", { name: "运行" });
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 3 次" })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 2 次" })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "查看运行 写入并检查 hello.txt 第 1 次" })).toBeInTheDocument();
  // 相邻三行同属一个工作流，工作流名只写在第一行的副行里。
  const metas = within(panel).getAllByText(/从来需求|从需求开始|从头开始|刚刚|分钟前/);
  expect(metas.filter((meta) => meta.textContent?.startsWith("AAW 轻量开发"))).toHaveLength(1);
  expect(metas.filter((meta) => meta.textContent?.startsWith("Python 转 Java"))).toHaveLength(1);
});

it("says how many runs there are in total and links to all of them", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns(Array.from({ length: 7 }, (_, index) => runSummary({ runId: `r${index}`, title: `运行 ${index}`, status: "completed", createdAt: index, updatedAt: index })));
  render(<WorkflowPanel service={fake.service} />);
  fireEvent.click(await screen.findByRole("tab", { name: /运行 7/ }));
  const panel = screen.getByRole("region", { name: "运行" });
  expect(within(panel).getByRole("button", { name: /查看全部 7 次/ })).toBeInTheDocument();
  // 列表只画最近 5 条，尾巴写清楚还有几条。
  expect(within(panel).getAllByRole("button", { name: /^查看运行/ })).toHaveLength(5);
  expect(within(panel).getByText(/最近 5 条/)).toBeInTheDocument();
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
  // 流程图预览：节点都未触发，点开能看到它会做什么
  fireEvent.click(await screen.findByRole("button", { name: "需求确认，未触发" }));
  // 这一步做什么现在直接写在卡片第二行（YAML 的 does），检视器里也还在。
  expect(within(screen.getByRole("complementary", { name: "节点说明" })).getByText("确认需求与边界")).toBeInTheDocument();
  expect(within(screen.getByRole("button", { name: "需求确认，未触发" })).getByText("确认需求与边界")).toBeInTheDocument();
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
  fake.service.requestPanel({ kind: "launch", launch: { workflowId: "aaw-dev", entry: "dev" } });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("region", { name: "启动 AAW 轻量开发" })).toBeInTheDocument();
});

it("opens the detail from the sidebar without opening the launch form", async () => {
  const fake = fakeWorkflowService();
  fake.service.requestPanel({ kind: "detail", workflowId: "aaw-dev" });
  render(<WorkflowPanel service={fake.service} />);
  expect(await screen.findByRole("navigation", { name: "位置" })).toHaveTextContent("AAW 轻量开发");
  expect(screen.queryByRole("region", { name: "启动 AAW 轻量开发" })).not.toBeInTheDocument();
});

it("lands on the latest run when it has not finished cleanly", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([runSummary({ runId: "r2", title: "中断的运行", status: "stopped" }), runSummary({ runId: "r1", status: "completed" })]);
  render(<WorkflowPanel service={fake.service} />);
  await vi.waitFor(() => expect(crumb()).toBe("中断的运行"));
});
