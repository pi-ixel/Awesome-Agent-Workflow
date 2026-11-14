import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffLines, withContext } from "../../../src/plugins/workflow/ui/textDiff.ts";
import { createDraftEditor, draftPrompt } from "../../../src/plugins/workflow/editing/draftSessions.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
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
    expect(prompt).toContain(".guide/workflow-format.md");
    expect(prompt).toContain("只改当前目录里的文件");
    expect(prompt).toContain("调用 check_workflow 工具检查");
    expect(prompt).toContain("用户的要求：加一个人工确认");
    expect(draftPrompt("new", "")).toContain("先简要说明");
  });

  it("会话工作目录指向草稿，消息交给 Agent，结束时释放连接", async () => {
    const port = {
      sessionId: "s-1",
      initialize: vi.fn(() => Promise.resolve({})),
      newSession: vi.fn((cwd: string, options: unknown) => { void cwd; void options; return Promise.resolve({}); }),
      prompt: vi.fn((text: string) => { void text; return Promise.resolve({ stopReason: "end_turn" }); }),
      cancel: vi.fn(),
    };
    let onUserMessage: ((sessionId: string, text: string) => Promise<void>) | undefined;
    const project = {
      projects: { workspace: { getState: () => ({ toolPaths: {} }) } },
      sessions: {
        adoptExternalSession: vi.fn(async (options: { workspacePath: string; title?: string; onUserMessage: typeof onUserMessage; create: (o: object, c: object) => Promise<unknown> }) => {
          onUserMessage = options.onUserMessage;
          await options.create({}, { agentKey: "k" });
          return { sessionId: "s-1" };
        }),
        openSessionFromEntry: vi.fn(() => Promise.resolve()),
      },
      conversation: { send: vi.fn(() => true) },
    };
    const protocol = { openIndependent: vi.fn(() => Promise.resolve(port)), release: vi.fn(() => Promise.resolve()) };
    const editor = createDraftEditor({
      project: project as never,
      agents: { resolve: () => ({ id: "agent-a" }), selectionKey: () => "key-a" } as never,
      protocol: protocol as never,
      currentProject: () => "D:/project",
    });
    const mcpServer = { name: "aaw-workflow-authoring", command: "workflow_service", args: ["--authoring-mcp", "D:/drafts/d1"], env: [] };
    await editor.start({ draftId: "d1", base: "mine", dir: "D:/drafts/d1", createdAt: 1, changes: 0, ok: true, mcpServer }, "编辑工作流：我的", "第一条");
    expect(project.sessions.adoptExternalSession).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "D:/project", title: "编辑工作流：我的", agentId: "agent-a" }));
    expect(port.newSession).toHaveBeenCalledWith("D:/drafts/d1", { mcpServers: [mcpServer] });
    expect(project.conversation.send).toHaveBeenCalledWith({ workspacePath: "D:/project", agentKey: "key-a", sessionId: "s-1" }, "第一条");
    expect(editor.has("d1")).toBe(true);
    await onUserMessage!("s-1", "再改一下");
    expect(port.prompt).toHaveBeenCalledWith("再改一下");
    expect(editor.send("d1", "报错")).toBe(true);
    await editor.end("d1");
    expect(protocol.release).toHaveBeenCalledWith(port);
    expect(editor.has("d1")).toBe(false);
    expect(editor.send("d1", "x")).toBe(false);
  });
});

function fakeEditor() {
  const live = new Set<string>();
  const started: string[] = [];
  const send = vi.fn((id: string, text: string) => { void id; void text; return true; });
  const end = vi.fn((id: string) => { live.delete(id); return Promise.resolve(); });
  const editor: WorkflowDraftEditor = {
    start: (draft: WorkflowDraft, _title: string, message: string) => { live.add(draft.draftId); started.push(message); return Promise.resolve(); },
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

it("asks for the request first, then creates the draft and opens the editing session", async () => {
  const fake = fakeWorkflowService();
  const { editor, started, end } = fakeEditor();
  fake.setDraftCheck({ ...broken, ok: true, diagnostics: [], changes: [] });
  render(<WorkflowPanel service={fake.service} editor={editor} />);

  fireEvent.click(await screen.findByRole("button", { name: "用 AI 新建" }));
  const sheet = screen.getByRole("dialog", { name: "让 AI 新建工作流" });
  expect(fake.calls.map((call) => call.method)).not.toContain("createDraft");
  fireEvent.click(within(sheet).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fake.calls.map((call) => call.method)).not.toContain("createDraft");

  fireEvent.click(screen.getByRole("button", { name: "用 AI 新建" }));
  const again = screen.getByRole("dialog", { name: "让 AI 新建工作流" });
  expect(within(again).getByRole("button", { name: "开始" })).toBeDisabled();
  fireEvent.change(within(again).getByRole("textbox", { name: "你的要求" }), { target: { value: "做一个先设计再实现的流程" } });
  fireEvent.click(within(again).getByRole("button", { name: "开始" }));
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
  render(<WorkflowPanel service={fake.service} editor={editor} />);

  const list = await screen.findByRole("list", { name: "未保存的草稿" });
  expect(list).toHaveTextContent("修改「mine」");
  expect(list).toHaveTextContent("改了 2 个文件 · 编译通过，可以保存");
  expect(screen.getByText("有未保存的修改")).toBeInTheDocument();

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
  render(<WorkflowPanel service={fake.service} editor={editor} />);
  fireEvent.click(await screen.findByRole("button", { name: /查看工作流 AAW 轻量开发/ }));
  fireEvent.click(await screen.findByRole("button", { name: "复制并用 AI 修改" }));
  const sheet = screen.getByRole("dialog", { name: /让 AI 修改/ });
  expect(sheet).toHaveTextContent("会先复制一份");
  fireEvent.change(within(sheet).getByRole("textbox", { name: "你的要求" }), { target: { value: "加一个人工确认" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "开始" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "createDraft", args: { base: "aaw-dev-copy" } }));
  expect(started[0]).toContain("用户的要求：加一个人工确认");
});

it("discards a draft from the library after confirmation", async () => {
  const fake = fakeWorkflowService();
  fake.addDraft({ draftId: "new-1", base: null, dir: "D:/drafts/new-1", createdAt: 1, changes: 0, ok: true, name: "我的工作流" });
  render(<WorkflowPanel service={fake.service} editor={fakeEditor().editor} />);
  const list = await screen.findByRole("list", { name: "未保存的草稿" });
  expect(list).toHaveTextContent("新建「我的工作流」");
  expect(list).toHaveTextContent("还没有改动");
  fireEvent.click(within(list).getByRole("button", { name: "放弃" }));
  fireEvent.click(within(within(list).getByRole("group", { name: "确认放弃" })).getByRole("button", { name: "放弃" }));
  await vi.waitFor(() => expect(fake.calls).toContainEqual({ method: "discardDraft", args: "new-1" }));
  await vi.waitFor(() => expect(screen.queryByRole("list", { name: "未保存的草稿" })).not.toBeInTheDocument());
});