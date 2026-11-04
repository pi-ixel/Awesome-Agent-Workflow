import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { panelService } from "../../src/core/panelService.ts";
import { pathKey } from "../../src/core/panelPaths.ts";
import {
  useMarkdownDocumentStore as documents,
  markdownDirty,
  saveMarkdownDocument,
  confirmMarkdownNavigation,
  settleMarkdownNavigation,
} from "../../src/stores/markdownDocumentStore.ts";
import { useRightPanelStore } from "../../src/stores/rightPanelStore.ts";
import { startNewSession } from "../../src/ui/workbench/sessionStart.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
const path = "D:/project/readme.md";
beforeEach(async () => {
  await settleMarkdownNavigation("cancel");
  documents.setState({ documents: {}, confirmation: false, promptError: null });
  vi.spyOn(panelService, "saveMarkdown").mockResolvedValue();
});
afterEach(async () => {
  await settleMarkdownNavigation("cancel");
  documents.setState({ documents: {}, confirmation: false, promptError: null });
  vi.restoreAllMocks();
});
const current = () => documents.getState().documents[pathKey(path)]!;
it("外部刷新只更新干净文档，脏文档保留草稿并提示冲突", () => {
  documents.getState().receive(path, "original");
  documents.getState().receive(path, "external");
  expect(current().text).toBe("external");
  documents.getState().edit(path, "my edit");
  documents.getState().receive(path, "another external");
  expect(current().text).toBe("my edit");
  expect(current().conflict).toBe(true);
  expect(current().base).toBe("external");
});
it("保存保留UTF8 BOM和CRLF，同时提交读取基线以检测并发修改", async () => {
  documents.getState().receive(path, "\uFEFF# 原文\r\n");
  documents.getState().edit(path, "# 新文\n");
  expect(await saveMarkdownDocument(path)).toBe(true);
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
  documents.getState().receive(path, "original");
  documents.getState().edit(path, "first edit");
  const saving = saveMarkdownDocument(path);
  documents.getState().edit(path, "continued edit");
  finish();
  await saving;
  expect(current().text).toBe("continued edit");
  expect(current().base).toBe("first edit");
  expect(markdownDirty(current())).toBe(true);
});
it("保存失败阻止导航，取消不改变内容或当前文件，放弃才执行切换", async () => {
  useRightPanelStore.setState({ projects: {} });
  useRightPanelStore.getState().openFile("D:/project", path);
  documents.getState().receive(path, "original");
  documents.getState().edit(path, "unsaved");
  useRightPanelStore.getState().openFile("D:/project", "D:/project/other.md");
  expect(documents.getState().confirmation).toBe(true);
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.active,
  ).toBe(`file:${pathKey(path)}`);
  vi.mocked(panelService.saveMarkdown).mockRejectedValueOnce(
    new Error("文件已变化"),
  );
  await settleMarkdownNavigation("save");
  expect(documents.getState().confirmation).toBe(true);
  expect(current().text).toBe("unsaved");
  await settleMarkdownNavigation("cancel");
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.active,
  ).toBe(`file:${pathKey(path)}`);
  useRightPanelStore.getState().openFile("D:/project", "D:/project/other.md");
  await settleMarkdownNavigation("discard");
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
  documents.getState().receive(path, "original");
  documents.getState().edit(path, "unsaved");
  const opening = startNewSession("D:/other-project");
  expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/project");
  await settleMarkdownNavigation("cancel");
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
  expect(documents.getState().confirmation).toBe(true);
  await settleMarkdownNavigation("cancel");
  expect(
    useRightPanelStore.getState().projects[pathKey("D:/project")]!.tabs,
  ).toHaveLength(1);
});
it("同一次确认中重复导航不排入多个动作", async () => {
  documents.getState().receive(path, "original");
  documents.getState().edit(path, "unsaved");
  const first = confirmMarkdownNavigation(),
    second = confirmMarkdownNavigation();
  expect(await second).toBe(false);
  await settleMarkdownNavigation("discard");
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
  documents.getState().receive(path, "original");
  documents.getState().edit(path, "saving edit");
  const saving = saveMarkdownDocument(path);
  documents.getState().edit(path, "original");
  const leaving = confirmMarkdownNavigation();
  expect(documents.getState().confirmation).toBe(true);
  const discarding = settleMarkdownNavigation("discard");
  finish();
  await saving;
  await discarding;
  expect(await leaving).toBe(true);
  expect(current().base).toBe("saving edit");
  expect(current().text).toBe("saving edit");
});
