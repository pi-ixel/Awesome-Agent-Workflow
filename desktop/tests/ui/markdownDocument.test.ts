import { readTestLayout, useRightPanelStore, useWorkbenchUiStore } from "../helpers/layout.ts";
import { createTestWorkspace } from "../helpers/workspace.ts";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { panelService } from "../../src/plugins/host/panelService.ts";
import { pathKey } from "../../src/shared/panelPaths.ts";
import { createTestDocuments } from "../helpers/documents.ts";
import { markdownDirty } from "../../src/plugins/documents/editor.ts";
import type { DocumentEditor } from "../../src/contracts/documents.ts";
import { startNewSession } from "../../src/plugins/project/sessionStart.ts";
const path = "D:/project/readme.md";
let fixture: ReturnType<typeof createTestDocuments>;
let editor: DocumentEditor;
let release: () => void;
beforeEach(() => {
  fixture = createTestDocuments();
  editor = fixture.editor;
  release = readTestLayout().navigationGuard.register({
    pending: () => editor.unsaved().length > 0,
    confirm: () => editor.confirm(),
    guard: (action, project) => editor.guard(action, project),
  });
  vi.spyOn(panelService, "saveMarkdown").mockResolvedValue();
});
afterEach(() => {
  release();
  fixture.dispose();
  vi.restoreAllMocks();
});
const current = () => editor.store.getState().documents[pathKey(path)]!;
it("外部刷新只更新干净文档，脏文档保留草稿并提示冲突", () => {
  editor.store.getState().receive(path, "original");
  editor.store.getState().receive(path, "external");
  expect(current().text).toBe("external");
  editor.store.getState().edit(path, "my edit");
  editor.store.getState().receive(path, "another external");
  expect(current().text).toBe("my edit");
  expect(current().conflict).toBe(true);
  expect(current().base).toBe("external");
});
it("保存保留UTF8 BOM和CRLF，同时提交读取基线以检测并发修改", async () => {
  editor.store.getState().receive(path, "\uFEFF# 原文\r\n");
  editor.store.getState().edit(path, "# 新文\n");
  expect(await editor.save(path)).toBe(true);
  expect(panelService.saveMarkdown).toHaveBeenCalledWith(
    path,
    "\uFEFF# 原文\r\n",
    "\uFEFF# 新文\r\n",
    false,
  );
  expect(markdownDirty(current())).toBe(false);
});
it("保存期间继续编辑不被迟到保存结果标记为已保存", async () => {
  let finish!: () => void;
  vi.mocked(panelService.saveMarkdown).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  editor.store.getState().receive(path, "original");
  editor.store.getState().edit(path, "first edit");
  const saving = editor.save(path);
  editor.store.getState().edit(path, "continued edit");
  finish();
  await saving;
  expect(current().text).toBe("continued edit");
  expect(current().base).toBe("first edit");
  expect(markdownDirty(current())).toBe(true);
});
it("保存失败阻止导航，取消不改变内容或当前文件，放弃才执行切换", async () => {
  useRightPanelStore.setState({ projects: {} });
  useRightPanelStore.getState().openFile("D:/project", path);
  editor.store.getState().receive(path, "original");
  editor.store.getState().edit(path, "unsaved");
  useRightPanelStore.getState().openFile("D:/project", "D:/project/other.md");
  expect(editor.store.getState().confirmation).toBe(true);
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.active,
  ).toBe(`file:${pathKey(path)}`);
  vi.mocked(panelService.saveMarkdown).mockRejectedValueOnce(
    new Error("文件已变化"),
  );
  await editor.settle("save");
  expect(editor.store.getState().confirmation).toBe(true);
  expect(current().text).toBe("unsaved");
  await editor.settle("cancel");
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.active,
  ).toBe(`file:${pathKey(path)}`);
  useRightPanelStore.getState().openFile("D:/project", "D:/project/other.md");
  await editor.settle("discard");
  await Promise.resolve();
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.active,
  ).toBe(`file:${pathKey("D:/project/other.md")}`);
});
it("切项目取消后保持原上下文和草稿，关闭文件同样提示", async () => {
  useWorkbenchUiStore.setState({
    contextPath: "D:/project",
    treeView: "session",
  });
  editor.store.getState().receive(path, "original");
  editor.store.getState().edit(path, "unsaved");
  const unused = () => { throw new Error("Navigation should be cancelled before opening"); };
  const opening = startNewSession(
    { beginDraft: unused, openSession: unused, enqueueSessionNavigation: unused, workspace: createTestWorkspace() },
    readTestLayout(),
    "D:/other-project",
    () => true,
  );
  expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/project");
  await editor.settle("cancel");
  expect((await opening).ok).toBe(false);
  expect(current().text).toBe("unsaved");
  useRightPanelStore.setState({
    projects: {
      [pathKey("D:/project")]: {
        open: true,
        width: 420,
        active: `file:${pathKey(path)}`,
        tabs: [{ id: `file:${pathKey(path)}`, kind: "file", path }],
      },
    },
  });
  useRightPanelStore.getState().closeAll("D:/project");
  expect(editor.store.getState().confirmation).toBe(true);
  await editor.settle("cancel");
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.tabs,
  ).toHaveLength(1);
});
it("同一次确认中重复导航不排入多个动作", async () => {
  editor.store.getState().receive(path, "original");
  editor.store.getState().edit(path, "unsaved");
  const first = editor.confirm(),
    second = editor.confirm();
  expect(await second).toBe(false);
  await editor.settle("discard");
  expect(await first).toBe(true);
});

it("保存尚未落盘时即使撤销到原文，切换仍需确认且放弃等待写入结束", async () => {
  let finish!: () => void;
  vi.mocked(panelService.saveMarkdown).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  editor.store.getState().receive(path, "original");
  editor.store.getState().edit(path, "saving edit");
  const saving = editor.save(path);
  editor.store.getState().edit(path, "original");
  const leaving = editor.confirm();
  expect(editor.store.getState().confirmation).toBe(true);
  const discarding = editor.settle("discard");
  finish();
  await saving;
  await discarding;
  expect(await leaving).toBe(true);
  expect(current().base).toBe("saving edit");
  expect(current().text).toBe("saving edit");
});
