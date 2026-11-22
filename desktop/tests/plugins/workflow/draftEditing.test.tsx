import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffLines, withContext } from "../../../src/plugins/workflow/ui/textDiff.ts";
import { createDraftEditor, draftPrompt } from "../../../src/plugins/workflow/editing/draftSessions.ts";
import { renderTemplates } from "./templateHarness.tsx";
import type { WorkflowDraft, WorkflowDraftCheck, WorkflowDraftEditor } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, workflowSummary } from "./helpers.ts";

afterEach(cleanup);

describe("逐行差异", () => {
  it("标出增删并保留上下文", () => {
    expect(diffLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "same", text: "a" }, { kind: "remove", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" }, { kind: "add", text: "d" },
    ]);
    expect(diffLines("", "x")).toEqual([{ kind: "add", text: "x" }]);
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const lines = withContext(diffLines(long, long.replace("l10", "L10")), 1);
    expect(lines).toEqual([null, { kind: "same", text: "l9" }, { kind: "remove", text: "l10" }, { kind: "add", text: "L10" }, { kind: "same", text: "l11" }, null]);
  });
});

describe("编辑会话", () => {
  it("第一条消息说明规则并带上用户的要求", () => {
    const prompt = draftPrompt("edit", "加一个人工确认");
    expect(prompt.text).toContain(".guide/workflow-format.md");
    expect(prompt.text).toContain("只改当前目录里的文件");
    expect(prompt.text).toContain("调用 check_workflow 工具检查");
    // 用户的要求照常显示，规则收成一行。
    expect(prompt.display).toEqual({ source: "workflow", visible: "用户的要求：加一个人工确认", foldLabel: "工作流给 Agent 的说明" });
    expect(prompt.text.startsWith("用户的要求：加一个人工确认")).toBe(true);
    expect(draftPrompt("new", "").text).toContain("先简要说明");
  });

  it("编辑会话是普通会话：工作目录指向草稿、带编写工具，第一条消息带显示方式，结束时停下这一轮", async () => {
    const target = { workspacePath: "D:/project", agentKey: "key-a", sessionId: "s-1" };
    const project = {
      sessions: {
        openPluginSession: vi.fn((options: { tools?: (agent: null) => readonly unknown[] }) => { void options; return Promise.resolve(target); }),
        openSessionFromEntry: vi.fn(() => Promise.resolve()),
      },
      conversation: { send: vi.fn(() => true), cancel: vi.fn() },
    };
    const editor = createDraftEditor({ project: project as never, currentProject: () => "D:/project" });
    const mcpServer = { name: "aaw-workflow-authoring", command: "workflow_service", args: ["--authoring-mcp", "D:/drafts/d1"], env: [] };
    const first = { text: "第一条", display: { source: "workflow", visible: "", foldLabel: "说明" } };
    await editor.start({ draftId: "d1", base: "mine", dir: "D:/drafts/d1", createdAt: 1, changes: 0, ok: true, mcpServer }, "编辑工作流：我的", first);
    const options = project.sessions.openPluginSession.mock.calls[0]![0] as { workspacePath: string; cwd: string; title: string; tools: (agent: null) => readonly unknown[] };
    expect(options).toMatchObject({ workspacePath: "D:/project", cwd: "D:/drafts/d1", title: "编辑工作流：我的" });
    expect(options.tools(null)).toEqual([mcpServer]);
    // 不抢前台：用户留在功能区的草稿页（ADR 038），要说话时再打开。
    expect(project.sessions.openSessionFromEntry).not.toHaveBeenCalled();
    expect(project.conversation.send).toHaveBeenCalledWith(target, "第一条", undefined, { display: first.display });
    // 重新打开或重连时，登记的提供方继续给这个会话编写工具。
    expect(
      editor.sessionTools({ ...target, agentId: "chrys", agent: null }),
    ).toEqual([mcpServer]);
    expect(
      editor.sessionTools({
        ...target,
        agentId: "chrys",
        sessionId: "other",
        agent: null,
      }),
    ).toEqual([]);
    expect(editor.has("d1")).toBe(true);
    expect(editor.send("d1", "报错")).toBe(true);
    expect(await editor.show("d1")).toBe(true);
    expect(project.sessions.openSessionFromEntry).toHaveBeenCalledWith("D:/project", "s-1", "key-a");
    await editor.end("d1");
    expect(project.conversation.cancel).toHaveBeenCalledWith(target);
    expect(editor.has("d1")).toBe(false);
    expect(editor.send("d1", "x")).toBe(false);
    expect(
      editor.sessionTools({ ...target, agentId: "chrys", agent: null }),
    ).toEqual([]);
  });
});

function fakeEditor() {
  const live = new Set<string>();
  const started: string[] = [];
  const send = vi.fn((id: string, text: string) => { void id; void text; return true; });
  const end = vi.fn((id: string) => { live.delete(id); return Promise.resolve(); });
  const editor: WorkflowDraftEditor = {
    start: (draft: WorkflowDraft, _title: string, message: { readonly text: string }) => { live.add(draft.draftId); started.push(message.text); return Promise.resolve(); },
    show: () => Promise.resolve(true),
    has: (id) => live.has(id),
    send,
    end,
  };
  return { editor, started, send, end };
}

const broken: WorkflowDraftCheck = {
  draft: { draftId: "new-1", base: null, dir: "D:/drafts/new-1", createdAt: 1, changes: 1, ok: false },
  ok: false, meta: null, catalogs: {},
  diagnostics: [{ severity: "error", file: "workflow.yaml", line: 3, path: "name", message: "缺少 name" }],
  changes: [{ path: "workflow.yaml", status: "modified", before: "id: my-workflow\n", after: "id: x\n" }],
};

it("asks for the request first, then creates the draft and stays on it with the session a click away", async () => {
  const fake = fakeWorkflowService();
  const { editor, started, end } = fakeEditor();
  fake.setDraftCheck({ ...broken, ok: true, diagnostics: [], changes: [] });
  renderTemplates(fake.service, { editor });

  fireEvent.click(await screen.findByRole("button", { name: "用 AI 新建" }));
  // 弹窗里只有输入框；Esc 关掉，什么也不留下。
  const sheet = screen.getByRole("dialog", { name: "用 AI 新建工作流" });
  expect(fake.calls.map((call) => call.method)).not.toContain("createDraft");
  fireEvent.keyDown(within(sheet).getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fake.calls.map((call) => call.method)).not.toContain("createDraft");

  fireEvent.click(screen.getByRole("button", { name: "用 AI 新建" }));
  const again = screen.getByRole("dialog", { name: "用 AI 新建工作流" });
  expect(within(again).getByRole("button", { name: "发送" })).toBeDisabled();
  const box = within(again).getByRole("textbox");
  fireEvent.change(box, { target: { value: "做一个先设计再实现的流程" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(started).toHaveLength(0);
  fireEvent.keyDown(box, { key: "Enter" });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(started[0]).toContain("用户的要求：做一个先设计再实现的流程");
  expect(await screen.findByRole("button", { name: "打开编辑会话" })).toBeInTheDocument();
  // 起步模板一点没改：不能保存。
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

  // AI 写坏了：面板同步显示报错，由 AI 用 check_workflow 自己修正。
  fake.setDraftCheck(broken);
  const report = await screen.findByRole("alert", { name: "编译报错" }, { timeout: 6000 });
  expect(report).toHaveTextContent("workflow.yaml:3（name）：缺少 name");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(report).toHaveTextContent("AI 会用 check_workflow 工具自己检查并修正");
  expect(within(report).queryByRole("button")).not.toBeInTheDocument();

  // 改好了：看差异、保存。
  fake.setDraftCheck({ ...broken, ok: true, diagnostics: [], meta: { ...workflowSummary().meta!, id: "x", name: "设计评审流程" } });
  expect(await screen.findByText(/新建：设计评审流程/, {}, { timeout: 6000 })).toBeInTheDocument();
  expect(screen.getByLabelText("差异 workflow.yaml")).toHaveTextContent("+ id: x");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "saveDraft", args: "new-1" }));
  expect(end).toHaveBeenCalledWith("new-1");
  // 要等草稿页两轮定时检查（每 3 秒一次），默认 5 秒不够。
}, 15_000);

it("returns to the existing draft of a workflow instead of creating another one", async () => {
  const fake = fakeWorkflowService();
  const { editor } = fakeEditor();
  fake.setLibrary([workflowSummary(), workflowSummary("mine", "user")]);
  fake.setDetail({ ...workflowSummary("mine", "user"), catalogs: {}, files: [], scripts: [] });
  fake.addDraft({ draftId: "mine-1", base: "mine", dir: "D:/drafts/mine-1", createdAt: 1, changes: 2, ok: true });
  fake.setDraftCheck({ draft: { draftId: "mine-1", base: "mine", dir: "D:/drafts/mine-1", createdAt: 1, changes: 2, ok: true }, ok: true, meta: null, catalogs: {}, diagnostics: [], changes: [] });
  renderTemplates(fake.service, { editor });

  fireEvent.click(await screen.findByRole("button", { name: /^我的/ }));
  // 修改已有工作流的草稿不单独成卡，标在原卡片上。
  const card = (await screen.findByRole("button", { name: "查看工作流 mine" })).closest("article")!;
  expect(within(card).getByText("草稿")).toBeInTheDocument();
  expect(within(card).queryByRole("img", { name: "有错误" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /打开草稿/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "查看工作流 mine" }));
  expect(await screen.findByLabelText("未保存的修改")).toHaveTextContent("改了 2 个文件");
  fireEvent.click(screen.getByRole("button", { name: "继续 AI 修改" }));
  expect(await screen.findByRole("group", { name: "继续编辑" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fake.calls.map((call) => call.method)).not.toContain("createDraft");
});

it("copies a preset before letting AI edit it", async () => {
  const fake = fakeWorkflowService();
  const { editor, started } = fakeEditor();
  fake.setDetail({ ...workflowSummary(), catalogs: {}, files: [], scripts: [] });
  renderTemplates(fake.service, { editor });
  fireEvent.click(await screen.findByRole("button", { name: /查看工作流 AAW 轻量开发/ }));
  fireEvent.click(await screen.findByRole("button", { name: "复制并用 AI 修改" }));
  const page = screen.getByRole("dialog", { name: /用 AI 修改/ });
  fireEvent.change(within(page).getByRole("textbox"), { target: { value: "加一个人工确认" } });
  fireEvent.click(within(page).getByRole("button", { name: "发送" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "createDraft", args: { base: "aaw-dev-copy" } }));
  expect(started[0]).toContain("用户的要求：加一个人工确认");
});

it("discards a draft from the library after confirmation", async () => {
  const fake = fakeWorkflowService();
  fake.addDraft({ draftId: "new-1", base: null, dir: "D:/drafts/new-1", createdAt: 1, changes: 0, ok: true, name: "我的工作流" });
  renderTemplates(fake.service, { editor: fakeEditor().editor });
  fireEvent.click(await screen.findByRole("button", { name: /^我的/ }));
  const card = (await screen.findByRole("button", { name: "打开草稿 我的工作流" })).closest("article")!;
  expect(within(card).getByText("草稿")).toBeInTheDocument();
  fireEvent.click(within(card).getByRole("button", { name: "放弃草稿" }));
  fireEvent.click(within(card).getByRole("button", { name: "确认放弃草稿" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "discardDraft", args: "new-1" }));
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "打开草稿 我的工作流" })).not.toBeInTheDocument());
});

it("marks a draft that has errors and opens it from its card", async () => {
  const fake = fakeWorkflowService();
  const draft = { draftId: "new-2", base: null, dir: "D:/drafts/new-2", createdAt: 1, changes: 1, ok: false, name: "坏草稿" };
  fake.addDraft(draft);
  fake.setDraftCheck({ draft, ok: false, meta: null, catalogs: {}, diagnostics: [], changes: [] });
  renderTemplates(fake.service, { editor: fakeEditor().editor });
  fireEvent.click(await screen.findByRole("button", { name: /^我的/ }));
  const open = await screen.findByRole("button", { name: "打开草稿 坏草稿" });
  expect(within(open).getByRole("img", { name: "有错误" })).toBeInTheDocument();
  fireEvent.click(open);
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "checkDraft", args: "new-2" }));
});