import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { matchesRun } from "../../../src/plugins/workflow/ui/runSearch.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import { fakeWorkflowService, runSummary } from "./helpers.ts";

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

it("matches the title, workflow name and requirement", () => {
  expect(matchesRun(runs[0]!, "短信")).toBe(true);
  expect(matchesRun(runs[0]!, "登录 轻量")).toBe(true);
  expect(matchesRun(runs[0]!, "支付")).toBe(false);
  expect(matchesRun(runs[0]!, "  ")).toBe(true);
});

it("searches, filters and reveals archived runs from the library", async () => {
  openAllRuns();
  fireEvent.click(await screen.findByRole("button", { name: /全部运行 · 3/ }));
  const page = screen.getByRole("region", { name: "全部运行" });
  expect(within(page).queryByText(/旧实验/)).not.toBeInTheDocument();
  fireEvent.click(within(page).getByLabelText(/显示已归档（1）/));
  expect(within(page).getByText("旧实验（已归档）")).toBeInTheDocument();
  fireEvent.change(within(page).getByRole("searchbox", { name: "搜索运行" }), { target: { value: "短信" } });
  expect(within(page).getAllByRole("button", { name: /查看运行/ }).map((item) => item.getAttribute("aria-label"))).toEqual(["查看运行 登录改造"]);
  fireEvent.change(within(page).getByRole("searchbox", { name: "搜索运行" }), { target: { value: "" } });
  fireEvent.change(within(page).getByRole("combobox", { name: "按状态筛选" }), { target: { value: "running" } });
  expect(within(page).getAllByRole("button", { name: /查看运行/ })).toHaveLength(1);
});

it("renames, archives and deletes after confirmation; running runs cannot be archived or deleted", async () => {
  const fake = openAllRuns();
  fireEvent.click(await screen.findByRole("button", { name: /全部运行/ }));
  const page = screen.getByRole("region", { name: "全部运行" });
  const row = (title: string) => within(page).getByRole("button", { name: `查看运行 ${title}` }).closest("li")!;

  expect(within(row("支付重构")).getByRole("button", { name: "归档" })).toBeDisabled();
  expect(within(row("支付重构")).getByRole("button", { name: "删除" })).toBeDisabled();

  fireEvent.click(within(row("登录改造")).getByRole("button", { name: "改标题" }));
  fireEvent.change(within(page).getByRole("textbox", { name: "运行标题" }), { target: { value: "短信登录" } });
  fireEvent.click(within(page).getByRole("button", { name: "保存" }));
  expect(await within(page).findByRole("button", { name: "查看运行 短信登录" })).toBeInTheDocument();
  expect(fake.calls).toContainEqual({ method: "renameRun", args: { runId: "r1", title: "短信登录" } });

  fireEvent.click(within(row("短信登录")).getByRole("button", { name: "归档" }));
  expect(await within(page).findByText(/显示已归档（2）/)).toBeInTheDocument();
  expect(within(page).queryByRole("button", { name: "查看运行 短信登录" })).not.toBeInTheDocument();

  fireEvent.click(within(page).getByLabelText(/显示已归档/));
  fireEvent.click(within(row("旧实验")).getByRole("button", { name: "删除" }));
  const confirm = within(page).getByRole("group", { name: "确认删除" });
  expect(confirm).toHaveTextContent("删除后不能恢复");
  fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
  expect(await screen.findByText(/显示已归档（1）/)).toBeInTheDocument();
  expect(fake.calls).toContainEqual({ method: "deleteRun", args: "r3" });
});
