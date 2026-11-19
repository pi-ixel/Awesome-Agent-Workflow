import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { entryCommands, runBriefs } from "../../../src/plugins/workflow/ui/workbench.tsx";
import { WorkflowSessionBanner } from "../../../src/plugins/workflow/ui/WorkflowSessionBanner.tsx";
import type { RunSessionLinks } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, workflowSummary } from "./helpers.ts";

afterEach(() => cleanup());

const links = (overrides: Partial<RunSessionLinks> = {}): RunSessionLinks => ({
  runId: "run-1",
  workflowName: "AAW 轻量开发",
  title: "给 logo 加底座",
  status: "running",
  active: true,
  links: [
    { sessionId: "s-design", actorName: "设计", nodes: [{ siteId: "design", ordinal: 2, status: "running", label: "设计", awaitingInput: true }] },
    { sessionId: "s-req", actorName: "需求确认", nodes: [{ siteId: "requirement", ordinal: 1, status: "completed", label: "需求确认", awaitingInput: false }] },
  ],
  ...overrides,
});

it("briefs only active runs for the session status card, waiting ones first", () => {
  const briefs = runBriefs([links({ runId: "quiet", title: "安静的运行", links: [] }), links(), links({ runId: "done", active: false })]);
  expect(briefs.map((brief) => brief.runId)).toEqual(["run-1", "quiet"]);
  expect(briefs[0]).toMatchObject({ title: "给 logo 加底座", label: "等你回复", waiting: true, step: "设计" });
  expect(briefs[1]).toMatchObject({ label: "运行中", waiting: false, step: null });
});

it("turns every workflow entry into a slash command that opens its launch form", () => {
  const launch = vi.fn();
  const enterprise = workflowSummary("aaw-enterprise");
  const twoEntries = {
    ...enterprise,
    meta: {
      ...enterprise.meta!,
      name: "AAW 完整开发",
      entries: [
        { id: "sr", label: "从 SR 需求开始", description: "从原始需求出发", inputs: [] },
        { id: "ar", label: "从单个 AR 开始", description: "", inputs: [] },
      ],
    },
  };
  const broken = { id: "broken", origin: "user" as const, meta: null, diagnostics: [] };
  const commands = entryCommands([workflowSummary(), twoEntries, broken], launch);
  expect(commands.map((command) => command.label)).toEqual(["AAW 轻量开发", "AAW 完整开发：从 SR 需求开始", "AAW 完整开发：从单个 AR 开始"]);
  commands[2]!.run();
  expect(launch).toHaveBeenCalledWith({ workflowId: "aaw-enterprise", entry: "ar" });
});

it("tells a node session which run and node it belongs to and links back to the run", () => {
  const fake = fakeWorkflowService();
  fake.service.sessionLinks = () => ({ workspace: "D:/p", runs: [links()] });
  const onOpenRun = vi.fn();
  render(<WorkflowSessionBanner service={fake.service} project="D:/p" sessionId="s-design" onOpenRun={onOpenRun} />);
  const banner = screen.getByRole("note", { name: "工作流节点会话" });
  expect(banner).toHaveTextContent("给 logo 加底座");
  expect(banner).toHaveTextContent("设计 · 第 2 轮");
  expect(banner).toHaveTextContent("等你回复");
  fireEvent.click(screen.getByRole("button", { name: "查看运行" }));
  expect(onOpenRun).toHaveBeenCalledWith("run-1");
});

it("renders nothing for an ordinary session or another project", () => {
  const fake = fakeWorkflowService();
  fake.service.sessionLinks = () => ({ workspace: "D:/p", runs: [links()] });
  const { container, rerender } = render(<WorkflowSessionBanner service={fake.service} project="D:/p" sessionId="user-session" onOpenRun={() => {}} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<WorkflowSessionBanner service={fake.service} project="D:/other" sessionId="s-design" onOpenRun={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

it("briefs a run that stopped at a confirmation gate as needing the user", () => {
  const briefs = runBriefs([links({ runId: "gate", active: false, status: "waiting" }), links({ runId: "idle", active: false, status: "stopped" })]);
  expect(briefs).toHaveLength(1);
  expect(briefs[0]).toMatchObject({ runId: "gate", label: "等你确认", waiting: true, step: "需求确认" });
});
