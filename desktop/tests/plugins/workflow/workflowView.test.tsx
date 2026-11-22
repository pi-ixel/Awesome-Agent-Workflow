import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { entryCommands, entryHint, entryInputsOf, runBriefs } from "../../../src/plugins/workflow/ui/workbench.tsx";
import { runSessionGroups } from "../../../src/plugins/workflow/ui/sessionGroups.ts";
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
    { sessionId: "s-design", actorName: "设计", nodes: [{ siteId: "design", ordinal: 2, status: "running", label: "设计", turn: "completed" }] },
    { sessionId: "s-req", actorName: "需求确认", nodes: [{ siteId: "requirement", ordinal: 1, status: "completed", label: "需求确认" }] },
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
  expect(banner).toHaveTextContent("设计第 2 轮");
  expect(banner).toHaveTextContent("等你回复");
  // 和画布同一套染色：等你回复用提醒色。
  expect(banner).toHaveClass("wf-strip", "tone-alert");
  fireEvent.click(screen.getByRole("button", { name: "查看运行" }));
  expect(onOpenRun).toHaveBeenCalledWith("run-1");
});

it("the strip speaks only for its own step, never for the whole run (station independence)", () => {
  const fake = fakeWorkflowService();
  // 运行停下（阻塞）了，但这个会话的这一步早已做完：工作流条只说「已完成」。
  const run = links({ active: false, status: "blocked" });
  fake.service.sessionLinks = () => ({ workspace: "D:/p", runs: [run] });
  render(<WorkflowSessionBanner service={fake.service} project="D:/p" sessionId="s-req" onOpenRun={() => {}} />);
  const banner = screen.getByRole("note", { name: "工作流节点会话" });
  expect(banner).toHaveTextContent("需求确认");
  expect(banner).toHaveTextContent("已完成");
  expect(banner).not.toHaveTextContent("阻塞");
  expect(banner).not.toHaveTextContent(/运行(失败|已)/);
  expect(banner.querySelector(".wf-pills")).toBeNull();
  expect(banner).toHaveClass("tone-done");
});

it("briefs a blocked run as needing the user, in the same word as the run list", () => {
  expect(runBriefs([links({ runId: "b", active: false, status: "blocked" })])[0]).toMatchObject({ label: "已阻塞", waiting: true });
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

/**
 * ADR 040：会话是唯一来源。同一个会话状态，输入框上的工作流条、侧栏分组、状态卡
 * 说同一个词，而且会话一变它们在同一次更新里跟着变。
 */
it("says what the session says, on every surface, the moment the session changes", () => {
  const fake = fakeWorkflowService();
  const run = links();
  fake.service.sessionLinks = () => ({ workspace: "D:/p", runs: [run] });
  render(<WorkflowSessionBanner service={fake.service} project="D:/p" sessionId="s-design" onOpenRun={() => {}} />);
  const strip = () => screen.getByRole("note", { name: "工作流节点会话" });
  const lookup = (sessionId: string | null | undefined) => (sessionId ? fake.service.sessionActivity?.getState().entries[sessionId]?.status : undefined);
  const sidebar = () => runSessionGroups([run], () => {}, undefined, undefined, lookup)[0]!;
  const card = () => runBriefs([run], lookup)[0]!;
  const cases = [
    ["running", "进行中", "tone-running"],
    ["cancelled", "你打断了", "tone-wait"],
    ["failed", "Agent 出错", "tone-alert"],
    ["waiting", "等你处理", "tone-alert"],
    ["completed", "等你回复", "tone-alert"],
  ] as const;
  for (const [status, word, tone] of cases) {
    act(() => fake.setSessionStatus("s-design", status));
    expect(strip()).toHaveTextContent(word);
    expect(strip()).toHaveClass(tone);
    // 状态卡说的是整次运行：没有要你做的事时就是「运行中」。
    expect(card()).toMatchObject(status === "running" ? { label: "运行中", waiting: false } : { label: word, waiting: true });
    if (status === "running") {
      expect(sidebar().members[0]).not.toHaveProperty("attention");
      expect(sidebar()).not.toHaveProperty("attention");
    } else {
      expect(sidebar().members[0]).toHaveProperty("attention", word);
      expect(sidebar()).toHaveProperty("attention", word);
    }
  }
});

it("says 正在停止 while a stop is in flight, not waiting for you", () => {
  const fake = fakeWorkflowService();
  const run = links({ stopping: true });
  fake.service.sessionLinks = () => ({ workspace: "D:/p", runs: [run] });
  render(<WorkflowSessionBanner service={fake.service} project="D:/p" sessionId="s-design" onOpenRun={() => {}} />);
  expect(screen.getByRole("note", { name: "工作流节点会话" })).toHaveTextContent("正在停止");
  expect(runBriefs([run])[0]).toMatchObject({ label: "正在停止", waiting: false });
  expect(runSessionGroups([run], () => {})[0]).toHaveProperty("attention", "正在停止");
});
