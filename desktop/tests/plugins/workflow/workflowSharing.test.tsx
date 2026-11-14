import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { WorkflowFileTransfer } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, workflowSummary } from "./helpers.ts";

afterEach(cleanup);

function transfer(text: string | null = '{"format":"aaw-workflow-package/1"}') {
  return {
    saveText: vi.fn((name: string, content: string) => { void name; void content; return Promise.resolve(true); }),
    openText: vi.fn(() => Promise.resolve(text)),
  } satisfies WorkflowFileTransfer;
}

it("previews an import, lists its scripts and opens the imported workflow", async () => {
  const fake = fakeWorkflowService();
  const files = transfer();
  fake.setImportResult({ id: "shared", meta: { ...workflowSummary("shared", "user").meta!, name: "分享的流程" }, diagnostics: [], scripts: ["scripts/task.py"] });
  fake.setLibrary([workflowSummary(), workflowSummary("shared", "user")]);
  fake.setDetail({ ...workflowSummary("shared", "user"), catalogs: {}, files: [{ path: "scripts/task.py", text: "print(1)" }], scripts: [{ path: "scripts/task.py", trusted: false }] });
  render(<WorkflowPanel service={fake.service} transfer={files} />);

  fireEvent.click(await screen.findByRole("button", { name: "导入…" }));
  const preview = await screen.findByRole("group", { name: "导入预览" });
  expect(preview).toHaveTextContent("分享的流程");
  expect(preview).toHaveTextContent("包含 1 个脚本");
  expect(preview).toHaveTextContent("scripts/task.py");
  expect(fake.calls.map((call) => call.method)).toContain("importWorkflow-preview");
  expect(fake.calls.map((call) => call.method)).not.toContain("importWorkflow");

  fireEvent.click(within(preview).getByRole("button", { name: "导入" }));
  const trust = await screen.findByRole("alert", { name: "脚本信任" });
  expect(trust).toHaveTextContent("1 个脚本还没确认信任");
  fireEvent.click(within(trust).getByRole("button", { name: "scripts/task.py" }));
  expect(screen.getByLabelText("scripts/task.py")).toHaveTextContent("print(1)");
  fireEvent.click(within(trust).getByRole("button", { name: "我已查看，信任这些脚本" }));
  await vi.waitFor(() => expect(screen.queryByRole("alert", { name: "脚本信任" })).not.toBeInTheDocument());
  expect(fake.calls).toContainEqual({ method: "trustScripts", args: "shared" });
});

it("refuses an invalid file with a readable reason", async () => {
  const fake = fakeWorkflowService();
  fake.setImportResult(new Error("WORKFLOW_PACKAGE_INVALID"));
  render(<WorkflowPanel service={fake.service} transfer={transfer("not json")} />);
  fireEvent.click(await screen.findByRole("button", { name: "导入…" }));
  expect(await screen.findByText(/这不是有效的工作流文件/)).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "导入预览" })).not.toBeInTheDocument();
});

it("exports a workflow through the save dialog", async () => {
  const fake = fakeWorkflowService();
  const files = transfer();
  fake.setDetail({ ...workflowSummary(), catalogs: {}, files: [], scripts: [] });
  render(<WorkflowPanel service={fake.service} transfer={files} />);
  fireEvent.click(await screen.findByRole("button", { name: /查看 AAW 轻量开发|AAW 轻量开发/ }));
  fireEvent.click(await screen.findByRole("button", { name: "更多" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "导出…" }));
  await vi.waitFor(() => expect(files.saveText).toHaveBeenCalledWith("aaw-dev.aaw-workflow.json", expect.stringContaining("aaw-workflow-package/1")));
  expect(await screen.findByRole("status")).toHaveTextContent("已导出");
});
