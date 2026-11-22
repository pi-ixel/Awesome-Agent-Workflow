import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { matchesRun } from "../../../src/plugins/workflow/ui/runSearch.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import { chooseOption, fakeWorkflowService, runSummary } from "./helpers.ts";

afterEach(cleanup);

const runs = [
  runSummary({ runId: "r1", title: "登录改造", name: "AAW 轻量开发", status: "completed", requirement: "支持短信登录", updatedAt: 3 }),
  runSummary({ runId: "r2", title: "支付重构", name: "AAW 轻量开发", status: "running", updatedAt: 2 }),
  runSummary({ runId: "r3", title: "旧实验", name: "AAW 轻量开发", status: "stopped", archivedAt: 1, updatedAt: 1 }),
];

function openAllRuns() {
  const fake = fakeWorkflowService();
  fake.setRuns(runs);
  render(<WorkflowPanel service={fake.service} />);
  return fake;
}

/** 右侧标签页的首页就是运行管理；落在某次运行上时，从面包屑回来。 */
async function openRunManager(): Promise<HTMLElement> {
  const crumb = screen.queryByRole("button", { name: "运行管理" });
  if (crumb) fireEvent.click(crumb);
  return screen.findByRole("region", { name: "运行管理" });
}

it("matches the title, workflow name and requirement", () => {
  expect(matchesRun(runs[0]!, "短信")).toBe(true);
  expect(matchesRun(runs[0]!, "登录 轻量")).toBe(true);
  expect(matchesRun(runs[0]!, "支付")).toBe(false);
  expect(matchesRun(runs[0]!, "  ")).toBe(true);
});

it("searches, filters and reveals archived runs from the top-level run manager", async () => {
  openAllRuns();
  const page = await openRunManager();
  expect(within(page).queryByText(/旧实验/)).not.toBeInTheDocument();
  const archivedToggle = within(page).getByRole("button", { name: "显示已归档" });
  expect(archivedToggle).toHaveTextContent("1");
  fireEvent.click(archivedToggle);
  expect(archivedToggle).toHaveAttribute("aria-pressed", "true");
  expect(within(page).getByText("旧实验（已归档）")).toBeInTheDocument();
  fireEvent.change(within(page).getByRole("searchbox", { name: "搜索运行" }), { target: { value: "短信" } });
  expect(within(page).getAllByRole("button", { name: /查看运行/ }).map((item) => item.getAttribute("aria-label"))).toEqual(["查看运行 登录改造 第 1 次"]);
  fireEvent.change(within(page).getByRole("searchbox", { name: "搜索运行" }), { target: { value: "" } });
  // 状态可以多选：勾了几种就看几种，面板不收起；一种都不勾等于不筛。
  const statusFilter = within(page).getByRole("combobox", { name: "按状态筛选" });
  chooseOption(statusFilter, "运行中");
  expect(within(page).getAllByRole("button", { name: /查看运行/ })).toHaveLength(1);
  fireEvent.click(within(page).getByRole("option", { name: "已停止" }));
  expect(statusFilter).toHaveTextContent("运行中、已停止");
  expect(within(page).getAllByRole("button", { name: /查看运行/ })).toHaveLength(2);
  fireEvent.click(within(page).getByRole("button", { name: "清除" }));
  expect(statusFilter).toHaveTextContent("全部状态");
  expect(within(page).getAllByRole("button", { name: /查看运行/ })).toHaveLength(3);
});

/** 每行行尾直接摆着改标题、归档 / 恢复、删除三个图标。 */
function action(row: HTMLElement, name: string): HTMLElement {
  return within(row).getByRole("button", { name });
}

it("renames, archives and deletes after confirmation; running runs cannot be archived or deleted", async () => {
  const fake = openAllRuns();
  const page = await openRunManager();
  const row = (title: string) => within(page).getByRole("button", { name: new RegExp(`^查看运行 ${title}`) }).closest("li")!;

  // 进行中的运行：图标留在原位变灰。
  expect(action(row("支付重构"), "归档")).toBeDisabled();
  expect(action(row("支付重构"), "删除")).toBeDisabled();

  fireEvent.click(action(row("登录改造"), "改标题"));
  fireEvent.change(within(page).getByRole("textbox", { name: "运行标题" }), { target: { value: "短信登录" } });
  fireEvent.click(within(page).getByRole("button", { name: "保存" }));
  expect(await within(page).findByRole("button", { name: /^查看运行 短信登录/ })).toBeInTheDocument();
  expect(fake.calls).toContainEqual({ method: "renameRun", args: { runId: "r1", title: "短信登录" } });

  // 归档也防误触：点一下变「确认」，再点一次才归档。
  fireEvent.click(action(row("短信登录"), "归档"));
  expect(fake.calls.some((call) => call.method === "archiveRun")).toBe(false);
  fireEvent.click(action(row("短信登录"), "确认归档"));
  const toggle = within(page).getByRole("button", { name: "显示已归档" });
  await waitFor(() => expect(toggle).toHaveTextContent("2"));
  expect(within(page).queryByRole("button", { name: /^查看运行 短信登录/ })).not.toBeInTheDocument();

  fireEvent.click(toggle);
  // 恢复不丢东西，直接生效，所以不用确认。
  expect(action(row("旧实验"), "恢复")).toBeEnabled();
  // 删除不能撤回：点一下变「确认」，再点一次才删。
  fireEvent.click(action(row("旧实验"), "删除"));
  expect(fake.calls.some((call) => call.method === "deleteRun")).toBe(false);
  fireEvent.click(action(row("旧实验"), "确认删除"));
  await waitFor(() => expect(toggle).toHaveTextContent("1"));
  expect(fake.calls).toContainEqual({ method: "deleteRun", args: "r3" });
});

it("lists runs of every project grouped by project, busy projects first, and opens another project's run there", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns(runs);
  fake.setOtherProjectRuns([
    { ...runs[0]!, project: "D:/work/app" },
    { ...runSummary({ runId: "x1", title: "接口文档", name: "AAW 轻量开发", status: "completed", updatedAt: 9 }), project: "D:/work/docs" },
    { ...runSummary({ runId: "x2", title: "埋点修复", name: "AAW 轻量开发", status: "running", updatedAt: 1 }), project: "D:/work/web" },
  ]);
  const opened = vi.fn();
  render(<WorkflowPanel service={fake.service} project="D:/work/app" onOpenProjectRun={opened} />);
  const page = await openRunManager();
  chooseOption(within(page).getByRole("combobox", { name: "范围" }), "全部项目");
  const history = await within(page).findByRole("region", { name: "运行记录" });
  const groups = await within(history).findAllByRole("region");
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["web", "docs", "app"]);
  expect(within(groups[2]!).getByText("当前项目")).toBeInTheDocument();
  fireEvent.click(within(page).getByRole("button", { name: "查看运行 埋点修复" }));
  expect(opened).toHaveBeenCalledWith("D:/work/web", "x2", { query: "", statuses: [], scope: "all", showArchived: false });
  const docs = within(groups[1]!).getByRole("button", { name: "查看运行 接口文档" }).closest("li")!;
  fireEvent.click(action(docs, "归档"));
  fireEvent.click(action(docs, "确认归档"));
  expect(fake.calls.find((call) => call.method === "archiveRun")?.args).toEqual({ runId: "x1", archived: true, project: "D:/work/docs" });
});

it("returns from a run to the same manager filters", async () => {
  openAllRuns();
  const page = await openRunManager();
  fireEvent.click(within(page).getByRole("button", { name: "显示已归档" }));
  fireEvent.change(within(page).getByRole("searchbox", { name: "搜索运行" }), { target: { value: "短信" } });
  chooseOption(within(page).getByRole("combobox", { name: "按状态筛选" }), "已完成");
  fireEvent.click(within(page).getByRole("button", { name: /查看运行 登录改造/ }));
  fireEvent.click(screen.getByRole("button", { name: "运行管理" }));
  const returned = screen.getByRole("region", { name: "运行管理" });
  expect(within(returned).getByRole("searchbox", { name: "搜索运行" })).toHaveValue("短信");
  expect(within(returned).getByRole("combobox", { name: "按状态筛选" })).toHaveTextContent("已完成");
  expect(within(returned).getByRole("button", { name: "显示已归档" })).toHaveAttribute("aria-pressed", "true");
  expect(within(returned).getAllByRole("button", { name: /查看运行/ })).toHaveLength(1);
});

it("restores the all-project filters in the destination panel after a cross-project run", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns(runs);
  fake.setOtherProjectRuns(runs.map((run) => ({ ...run, project: "D:/work/app" })));
  fake.service.requestPanel({
    kind: "run", project: "D:/work/app", runId: "r1",
    returnFilters: { query: "短信", statuses: ["completed"], scope: "all", showArchived: true },
  });
  render(<WorkflowPanel service={fake.service} project="D:/work/app" onOpenProjectRun={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "运行管理" }));
  const page = screen.getByRole("region", { name: "运行管理" });
  expect(within(page).getByRole("searchbox", { name: "搜索运行" })).toHaveValue("短信");
  expect(within(page).getByRole("combobox", { name: "范围" })).toHaveTextContent("全部项目");
  expect(within(page).getByRole("combobox", { name: "按状态筛选" })).toHaveTextContent("已完成");
  expect(await within(page).findByRole("button", { name: "查看运行 登录改造" })).toBeInTheDocument();
});
