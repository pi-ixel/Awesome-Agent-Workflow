import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowSidebar } from "../../../src/plugins/workflow/ui/WorkflowSidebar.tsx";
import { fakeWorkflowService, runSummary, workflowSummary } from "./helpers.ts";

it("opens templates and shows only the active project's run records", async () => {
  const fake = fakeWorkflowService();
  let workspace = "D:/other";
  const project = "D:/demo";
  const service = { ...fake.service, sessionLinks: () => ({ workspace, runs: [] }) };
  const openWorkflow = vi.fn();
  const openRun = vi.fn();
  fake.setLibrary([workflowSummary(), workflowSummary("custom", "user")]);
  fake.setRuns([runSummary({ runId: "other", title: "其他项目的运行" })]);
  render(<WorkflowSidebar project={project} service={service} onOpenWorkflow={openWorkflow} onOpenRun={openRun} />);

  fireEvent.click(await screen.findByRole("button", { name: "AAW 轻量开发" }));
  expect(openWorkflow).toHaveBeenCalledWith("aaw-dev");
  fireEvent.click(screen.getByRole("button", { name: "我的" }));
  fireEvent.click(screen.getByRole("button", { name: "custom" }));
  expect(openWorkflow).toHaveBeenCalledWith("custom");

  fireEvent.click(screen.getByRole("button", { name: "运行" }));
  expect(screen.queryByText("其他项目的运行")).not.toBeInTheDocument();
  workspace = project;
  act(() => fake.setRuns([runSummary({ runId: "run-1", title: "当前项目的运行" })]));
  fireEvent.click(screen.getByRole("button", { name: /当前项目的运行/ }));
  expect(openRun).toHaveBeenCalledWith("run-1");
});
