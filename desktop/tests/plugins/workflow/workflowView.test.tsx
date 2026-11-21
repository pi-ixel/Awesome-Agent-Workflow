import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { entryCommands, entryHint, entryInputsOf, runBriefs } from "../../../src/plugins/workflow/ui/workbench.tsx";
import { WorkflowIcon } from "../../../src/shared/ui/icons.tsx";
import { WorkflowSessionBanner } from "../../../src/plugins/workflow/ui/WorkflowSessionBanner.tsx";
import type { RunSessionLinks, WorkflowEntry } from "../../../src/plugins/workflow/types.ts";
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

it("turns every workflow entry into a slash send target with the workflow's own hint", () => {
  const enterprise = workflowSummary("aaw-enterprise");
  const twoEntries = {
    ...enterprise,
    meta: {
      ...enterprise.meta!,
      name: "AAW 完整开发",
      entries: [
        { id: "sr", label: "从 SR 需求开始", description: "从原始需求出发", hint: "粘贴原始需求，Enter 开始运行", inputs: [] },
        { id: "ar", label: "从单个 AR 开始", description: "", inputs: [] },
      ],
    },
  };
  const broken = { id: "broken", origin: "user" as const, meta: null, diagnostics: [] };
  const submit = vi.fn((workflowId: string, entry: WorkflowEntry) => { void workflowId; void entry; return () => Promise.resolve(); });
  const commands = entryCommands([workflowSummary(), twoEntries, broken], submit);
  expect(commands.map((command) => command.label)).toEqual(["AAW 轻量开发", "AAW 完整开发：从 SR 需求开始", "AAW 完整开发：从单个 AR 开始"]);
  // 「/」菜单里和技能一样带图标；都是发送对象，没有发起表单。
  expect(commands.every((command) => command.Icon === WorkflowIcon && typeof command.submit === "function")).toBe(true);
  expect(commands.map((command) => command.placeholder)).toEqual(["本次需求，Enter 开始运行", "粘贴原始需求，Enter 开始运行", "给这次运行起个标题，Enter 开始运行"]);
  expect(submit).toHaveBeenCalledWith("aaw-enterprise", twoEntries.meta.entries[1]);
});

it("hands the composer text to the entry's inputs and leaves missing ones for the engine to report", () => {
  const text = (name: string, required = true) => ({ name, label: name, kind: "text" as const, required, placeholder: "" });
  const files = (name: string, required = true) => ({ name, label: "相关文件", kind: "files" as const, required, placeholder: "" });
  const entry = (inputs: WorkflowEntry["inputs"]) => ({ id: "e", label: "e", description: "", inputs });
  expect(entryInputsOf(entry([text("requirement")]), "做一件事")).toEqual({ inputs: { requirement: "做一件事" } });
  // 什么都不要：这段话当标题。
  expect(entryInputsOf(entry([]), "试一次")).toEqual({ inputs: {}, title: "试一次" });
  // 必填的文字优先；@ 引用的文件填进文件输入。
  expect(entryInputsOf(entry([text("note", false), text("requirement"), files("docs")]), "看 @docs/a.md 和 @b.ts 再改"))
    .toEqual({ inputs: { requirement: "看 @docs/a.md 和 @b.ts 再改", docs: ["docs/a.md", "b.ts"] } });
  // 两段必填文字：只填得了第一段，第二段交给引擎报缺。
  expect(entryInputsOf(entry([text("a"), text("b")]), "x")).toEqual({ inputs: { a: "x" } });
  // 没有写 hint 时按输入生成提示。
  expect(entryHint(entry([text("本次需求"), files("docs")]))).toBe("本次需求，用 @ 引用相关文件，Enter 开始运行");
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
