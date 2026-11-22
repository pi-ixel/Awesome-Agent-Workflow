import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkflowSidebar } from "../../../src/plugins/workflow/ui/WorkflowSidebar.tsx";
import { createTemplateNavigation } from "../../../src/plugins/workflow/ui/templateNavigation.ts";
import { fakeWorkflowService, runSummary, workflowSummary } from "./helpers.ts";

it("switches template categories with counts, offers AI creation, and lists no runs", async () => {
  const fake = fakeWorkflowService();
  const navigation = createTemplateNavigation();
  fake.setLibrary([workflowSummary(), workflowSummary("custom", "user"), workflowSummary("second", "user")]);
  fake.setRuns([runSummary({ runId: "run-1", title: "当前项目的运行" })]);
  render(<WorkflowSidebar service={fake.service} navigation={navigation} canCompose />);

  const categories = screen.getByRole("region", { name: "工作流分类" });
  const mine = within(categories).getByRole("button", { name: /^我的/ });
  expect(await within(mine).findByText("2")).toBeInTheDocument();
  navigation.setState({ route: { kind: "workflow", id: "aaw-dev" } });
  fireEvent.click(mine);
  expect(navigation.getState()).toMatchObject({ tab: "mine", route: { kind: "library" } });
  expect(mine).toHaveAttribute("aria-current", "true");

  fireEvent.click(within(categories).getByRole("button", { name: "用 AI 新建" }));
  expect(navigation.getState().compose).toEqual({ kind: "new" });
  expect(screen.queryByText("当前项目的运行")).not.toBeInTheDocument();
});

it("hides AI creation when there is no editing session support", () => {
  const fake = fakeWorkflowService();
  render(<WorkflowSidebar service={fake.service} navigation={createTemplateNavigation()} canCompose={false} />);
  expect(screen.queryByRole("button", { name: "用 AI 新建" })).not.toBeInTheDocument();
});
