import { mutableProjectForeground } from "../helpers/foreground.ts";
import { annotationDraftOwner } from "../helpers/projectAnnotationDrafts.ts";
import type { Context } from "cordis";
import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as documentsPlugin from "../../src/plugins/documents/index.ts";
import * as gitPlugin from "../../src/plugins/git/index.ts";
import * as projectPlugin from "../../src/plugins/project/index.ts";
import { expect, it, vi } from "vitest";
import type { DirectoryResult, DocumentFileHost } from "../../src/plugins/host/types.ts";
import { createDocuments } from "../../src/plugins/documents/files/documents.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { NativePanelService } from "../../src/plugins/host/filesystem/panelService.ts";
import * as documentHost from "../../src/plugins/host/filesystem/documentFiles.ts";
import { createTestDocuments } from "../helpers/documents.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { documentTab } from "../../src/plugins/documents/ui/documentTabs.tsx";
import { draftScopeKey } from "../../src/plugins/project/composer/scope.ts";

function fileHost() {
  return {
    stat: vi.fn<DocumentFileHost["stat"]>(),
    openInFileManager: vi.fn<DocumentFileHost["openInFileManager"]>(),
    assetUrl: vi.fn<DocumentFileHost["assetUrl"]>(),
    directory: vi.fn<DocumentFileHost["directory"]>(),
    preview: vi.fn<DocumentFileHost["preview"]>(),
    saveMarkdown: vi.fn<DocumentFileHost["saveMarkdown"]>(),
    listWorkspaceFiles: vi.fn<DocumentFileHost["listWorkspaceFiles"]>(),
    watch: vi.fn<DocumentFileHost["watch"]>(),
  };
}

it("installs document contributions and scopes project close to the addressed project", async () => {
  const workspaceKey = "aaw-desktop/workspace/v1";
  const savedWorkspace = localStorage.getItem(workspaceKey);
  localStorage.removeItem(workspaceKey);
  const closeProject = vi.fn(() => Promise.resolve());
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
      closeProject,
    },
    undefined,
    installDesktopWorkbench,
  );
  try {
    const { project, documents, workbench } = await runtime.ready;
    expect(workbench.getSnapshot().pathResolvers.map(({ id }) => id)).toEqual(["documents"]);
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["files", "file", "directory"]),
    );
    expect(workbench.getSnapshot().overlays.map(({ id }) => id)).toContain(
      "documents-dialogs",
    );
    const { editor } = documents;
    const edit = (path: string) => {
      editor.receive(path, "saved");
      editor.edit(path, "edited");
    };
    const external = "E:/shared/readme.md";
    const other = "D:/other/readme.md";
    project.projects.openWorkspace("D:/other");
    project.projects.openWorkspace("D:/demo");
    const projects = () => project.projects.workspace.getState().recentWorkspaces.map(({ path }) => path);
    const retired = vi.fn();
    const unregister = project.projects.registerProjectClose({
      id: "retiring-participant",
      check() {
        unregister();
        return Promise.resolve(true);
      },
      closed: retired,
    });
    await expect(project.projects.removeProject("D:/demo")).resolves.toBe(false);
    expect(closeProject).not.toHaveBeenCalled();
    expect(retired).not.toHaveBeenCalled();
    expect(projects()).toEqual(["D:/demo", "D:/other"]);
    // Keep an external edit associated with its owning project after the tab unmounts.
    const release = editor.retain(external, "D:/demo");
    edit(external);
    release();
    edit(other);
    expect(workbench.navigationGuard.pending()).toBe(true);
    const cancelled = project.projects.removeProject("D:/demo");
    expect(project.projects.removeProject("d:\\DEMO")).toBe(cancelled);
    await vi.waitFor(() =>
      expect(editor.state.getState().confirmationProject).toBe("D:/demo"),
    );
    expect(closeProject).not.toHaveBeenCalled();
    expect(editor.unsaved("D:/demo").map(({ path }) => path)).toEqual([
      external,
    ]);
    await editor.settle("cancel");
    await expect(cancelled).resolves.toBe(false);
    expect(closeProject).not.toHaveBeenCalled();
    expect(editor.unsaved()).toHaveLength(2);
    expect(projects()).toEqual(["D:/demo", "D:/other"]);

    const accepted = project.projects.removeProject("D:/demo");
    await vi.waitFor(() =>
      expect(editor.state.getState().confirmation).toBe(true),
    );
    await editor.settle("discard");
    await expect(accepted).resolves.toBe(true);
    expect(closeProject).toHaveBeenCalledExactlyOnceWith("D:/demo");
    expect(editor.unsaved().map(({ path }) => path)).toEqual([other]);
    expect(projects()).toEqual(["D:/other"]);
    expect(project.projects.workspace.getState().activePath).toBeNull();
    await runtime.shutdown();
    expect(editor.state.getState().documents).toEqual({});
    expect(workbench.getSnapshot().panels).toEqual([]);
  } finally {
    await runtime.shutdown();
    if (savedWorkspace === null) localStorage.removeItem(workspaceKey);
    else localStorage.setItem(workspaceKey, savedWorkspace);
  }
});

it("reattaches Git status to a mounted file tree on the same root", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  const project = "D:/git-documents";
  const status = vi.spyOn(NativePanelService.prototype, "gitStatus").mockResolvedValue({
    repoRoot: project, branch: "main", changes: [], watchPaths: [],
  });
  const directory = vi.spyOn(NativePanelService.prototype, "directory").mockResolvedValue({ entries: [], truncated: false });
  let unmount: (() => void) | undefined;
  try {
    const { workbench } = await runtime.ready;
    const context = root;
    const [fiber] = context?.registry.get(gitPlugin)?.fibers ?? [];
    const panel = workbench.getSnapshot().panels.find(({ id }) => id === "files");
    if (!context || !fiber || !panel) throw new Error("Git or Documents is missing");
    const mounted = render(createElement(WorkbenchContext.Provider, { value: workbench },
      createElement(panel.View, { project, tab: undefined, visible: true, openPath: vi.fn() }),
    ));
    unmount = mounted.unmount;
    await screen.findByRole("button", { name: "仅显示变更文件" });
    expect(status).toHaveBeenCalledWith(project);

    await act(async () => { await fiber.dispose(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "仅显示变更文件" })).not.toBeInTheDocument());
    status.mockClear();
    await act(async () => { await context.plugin(gitPlugin); });
    await screen.findByRole("button", { name: "仅显示变更文件" });
    expect(status).toHaveBeenCalledWith(project);
    expect(workbench.getSnapshot().panels.find(({ id }) => id === "files")).toBe(panel);
  } finally {
    unmount?.();
    await runtime.shutdown();
    status.mockRestore();
    directory.mockRestore();
  }
});

it("opens the file tree from the registered Project sidebar and retires old document navigation", async () => {
  const path = "D:/document-navigation";
  const file = path + "/notes.md";
  let finish!: (entry: Awaited<ReturnType<DocumentFileHost["stat"]>>) => void;
  const entry = { path: file, name: "notes.md", directory: false, symlink: false };
  const stat = vi.fn<DocumentFileHost["stat"]>()
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue(entry);
  const createHost = documentHost.createDocumentFileHost;
  const host = vi.spyOn(documentHost, "createDocumentFileHost")
    .mockImplementation((...args) => ({ ...createHost(...args), stat }));
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  let unmount: (() => void) | undefined;
  try {
    const { project, workbench } = await runtime.ready;
    const context = root;
    const [fiber] = context?.registry.get(documentsPlugin)?.fibers ?? [];
    const sidebar = workbench.getSnapshot().sidebar.find(({ id }) => id === "project-tree");
    if (!context || !fiber || !sidebar) throw new Error("Documents or Project is missing");
    project.projects.openWorkspace(path);
    unmount = render(createElement(sidebar.View)).unmount;
    await userEvent.click(screen.getByRole("button", { name: "浏览项目文件" }));
    expect(workbench.navigation.getState()).toMatchObject({ viewId: "project-overview", contextPath: path });
    expect(workbench.panels.getState().projects[path.toLowerCase()]).toMatchObject({ active: "files", open: true });

    const old = context.documentsUi;
    const pending = old.openPath(path, file, 7);
    expect(stat).toHaveBeenCalledOnce();
    await act(async () => { await fiber.dispose(); });
    finish(entry);
    await expect(pending).resolves.toBe(false);
    expect(workbench.getSnapshot().pathResolvers).toEqual([]);
    workbench.panels.getState().collapse(path);
    old.openFileTree(path);
    expect(workbench.panels.getState().projects[path.toLowerCase()]?.open).toBe(false);

    await act(async () => { await context.plugin(documentsPlugin); });
    expect(context.documentsUi).not.toBe(old);
    await expect(context.documentsUi.openPath(path, file, 7)).resolves.toBe(true);
    expect(workbench.panels.getState().projects[path.toLowerCase()]?.tabs).toContainEqual(
      expect.objectContaining({ kind: "file", data: { path: file, line: 7 } }),
    );
  } finally {
    unmount?.();
    await runtime.shutdown();
    host.mockRestore();
  }
});

it("keeps a mounted file annotation editor on the original draft, follows promotion and retires with Project", async () => {
  const path = "D:/annotation-targets";
  const file = path + "/notes.md";
  const quote = "待评审的段落";
  const preview = vi.spyOn(NativePanelService.prototype, "preview").mockResolvedValue({
    kind: "text", content: quote, bytes: 18, mime: "text/markdown",
  });
  const watch = vi.spyOn(NativePanelService.prototype, "watch").mockResolvedValue(() => {});
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  let unmount: (() => void) | undefined;
  try {
    const { project, workbench } = await runtime.ready;
    const context = root;
    const [fiber] = context?.registry.get(projectPlugin)?.fibers ?? [];
    const panel = workbench.getSnapshot().panels.find(({ id }) => id === "file");
    if (!context || !fiber || !panel) throw new Error("Project or Documents is missing");
    project.projects.openWorkspace(path);
    workbench.navigation.getState().openView("project-overview", path);
    const { session } = mutableProjectForeground(project);
    session.setState({ activeSessionId: "same", agentKey: "agent-a", isBound: true });
    const editor = project.drafts.annotationEditor;
    const original = editor.current(path)!;
    unmount = render(createElement(panel.View, {
      project: path,
      tab: documentTab(file, false),
      visible: true,
      openPath: vi.fn(),
    })).unmount;
    const paragraph = await screen.findByText(quote);
    const edit = (comment: string) => {
      const text = paragraph.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, quote.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      fireEvent.keyUp(paragraph, { key: "Shift" });
      fireEvent.click(screen.getByRole("button", { name: "批注" }));
      fireEvent.change(screen.getByRole("textbox", { name: "批注意见" }), { target: { value: comment } });
    };
    const save = () => fireEvent.click(screen.getByRole("button", { name: "添加到会话" }));

    edit("原会话的批注");
    act(() => session.setState({ agentKey: "agent-b" }));
    const otherAgent = editor.current(path)!;
    expect(otherAgent).not.toBe(original);
    save();
    expect(editor.read(original)).toMatchObject([{ comment: "原会话的批注" }]);
    expect(editor.read(otherAgent)).toEqual([]);
    expect(screen.getByText("已保存到原会话草稿")).toBeVisible();
    expect(workbench.navigation.getState().viewId).toBe("project-overview");

    act(() => session.setState({ activeSessionId: null }));
    const newDraft = editor.current(path)!;
    act(() => session.setState({ agentKey: "agent-c" }));
    expect(editor.current(path)).toBe(newDraft);
    edit("转正后仍在编辑");
    act(() => {
      annotationDraftOwner(project.drafts.annotationDrafts).migrate(
        draftScopeKey(path, null),
        draftScopeKey(path, "created", "agent-c"),
      );
      session.setState({ activeSessionId: "created" });
    });
    const promoted = editor.current(path)!;
    expect(promoted).not.toBe(newDraft);
    save();
    expect(editor.read(promoted)).toMatchObject([{ comment: "转正后仍在编辑" }]);
    expect(editor.read(newDraft)).toEqual([]);
    expect(workbench.navigation.getState().viewId).toBe("session");

    edit("随旧实例丢弃的编辑");
    const onTarget = vi.fn();
    const onDraft = vi.fn();
    editor.subscribeTarget(onTarget);
    editor.subscribeDrafts(onDraft);
    await act(async () => { await fiber.dispose(); });
    expect(screen.queryByRole("dialog", { name: "文档批注" })).not.toBeInTheDocument();
    expect(editor.current(path)).toBeUndefined();
    expect(editor.remove(promoted, "unused")).toBe(false);
    await act(async () => {
      await context.plugin(projectPlugin, fiber.config as Parameters<typeof projectPlugin.apply>[1]);
      context.project.projects.openWorkspace(path);
      mutableProjectForeground(context.project).session.setState({
        activeSessionId: "created", agentKey: "agent-c", isBound: true,
      });
    });
    const replacement = context.project.drafts.annotationEditor;
    expect(replacement.current(path)).not.toBe(promoted);
    expect(replacement.read(promoted)).toEqual([]);
    expect(replacement.read(replacement.current(path)!)).toMatchObject([{ comment: "转正后仍在编辑" }]);
    expect(onTarget).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
  } finally {
    window.getSelection()?.removeAllRanges();
    unmount?.();
    await runtime.shutdown();
    preview.mockRestore();
    watch.mockRestore();
  }
});

it("rebinds file candidates in the registered session page after Documents reload", async () => {
  let finish!: (paths: readonly string[]) => void;
  const list = vi.fn<DocumentFileHost["listWorkspaceFiles"]>()
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(["new-instance.md"]);
  const createHost = documentHost.createDocumentFileHost;
  const host = vi.spyOn(documentHost, "createDocumentFileHost")
    .mockImplementation((...args) => ({
      ...createHost(...args),
      listWorkspaceFiles: list,
    }));
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  let unmount: (() => void) | undefined;
  try {
    const { project, workbench } = await runtime.ready;
    const context = root;
    const [fiber] = context?.registry.get(documentsPlugin)?.fibers ?? [];
    const session = workbench.getSnapshot().pages.find(({ id }) => id === "session");
    if (!context || !fiber || !session) throw new Error("Documents or Project is missing");
    const path = "D:/document-session";
    project.projects.openWorkspace(path);
    workbench.navigation.getState().openView("session", path);
    const view = render(createElement(WorkbenchContext.Provider, { value: workbench },
      createElement(session.View, { project: path }),
    ));
    unmount = view.unmount;
    await userEvent.type(screen.getByLabelText("消息输入框"), "@");
    await screen.findByText("正在读取文件列表…");
    expect(list).toHaveBeenCalledExactlyOnceWith(path);

    await act(async () => { await fiber.dispose(); });
    await screen.findByText("没有匹配的文件或 skill");
    await act(async () => { await context.plugin(documentsPlugin); });
    expect(await screen.findByRole("option", { name: /new-instance/ })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    await act(() => { finish(["retired-instance.md"]); return Promise.resolve(); });
    expect(screen.queryByRole("option", { name: /retired-instance/ })).not.toBeInTheDocument();
    expect(workbench.getSnapshot().pages.find(({ id }) => id === "session")).toBe(session);
    expect(screen.getByLabelText("消息输入框")).toHaveValue("@");
  } finally {
    finish([]);
    unmount?.();
    await runtime.shutdown();
    host.mockRestore();
  }
});

it("releases active and late watches for a closed project while other projects remain active", async () => {
  const host = fileHost();
  const documents = createDocuments(host);
  const active = vi.fn();
  const other = vi.fn();
  const late = vi.fn();
  let finish!: (stop: () => void) => void;
  host.watch
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(other)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  const changed = vi.fn();
  const failed = vi.fn();
  const paths = [{ path: "E:/external", recursive: false }];
  const stopActive = await documents.watch("D:/demo", paths, changed, failed);
  await documents.watch("D:/other", paths, changed, failed);
  const pending = documents.watch("D:/demo", paths, changed, failed);
  documents.releaseProject("d:\\DEMO");
  expect(active).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  host.watch.mock.calls[0]?.[1]();
  host.watch.mock.calls[2]?.[2]("late");
  expect(changed).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  host.watch.mock.calls[1]?.[1]();
  expect(changed).toHaveBeenCalledOnce();
  finish(late);
  (await pending)();
  stopActive();
  expect(late).toHaveBeenCalledOnce();
  expect(active).toHaveBeenCalledOnce();
  documents.dispose();
  expect(other).toHaveBeenCalledOnce();
  await expect(documents.preview("E:/external/a.md")).rejects.toThrow(
    "disposed",
  );
});

it("cancels an outstanding document decision and drops a late save result on disposal", async () => {
  const host = fileHost();
  const documents = createDocuments(host);
  const { editor } = documents;
  let finish!: () => void;
  host.saveMarkdown.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const path = "D:/demo/readme.md";
  editor.receive(path, "saved");
  editor.edit(path, "edited");
  const save = editor.save(path);
  const check = editor.confirm();
  expect(editor.state).not.toHaveProperty("setState");
  expect(editor.state.getState()).not.toHaveProperty("edit");
  const observer = vi.fn();
  editor.state.subscribe(observer);
  documents.dispose();
  await expect(check).resolves.toBe(false);
  finish();
  await expect(save).resolves.toBe(false);
  editor.receive(path, "stale");
  editor.edit(path, "stale");
  expect(observer).not.toHaveBeenCalled();
  expect(editor.state.getState()).toMatchObject({
    documents: {},
    confirmation: false,
  });
});

it("drops an in-flight file index when the addressed project closes", async () => {
  const host = fileHost();
  const documents = createDocuments(host);
  let finish!: (paths: readonly string[]) => void;
  host.listWorkspaceFiles.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = documents.listWorkspaceFiles("D:/demo");
  documents.releaseProject("D:/demo");
  host.listWorkspaceFiles.mockResolvedValueOnce(["new.md"]);
  await expect(documents.listWorkspaceFiles("D:/demo")).resolves.toEqual([
    "new.md",
  ]);
  finish(["old.md"]);
  await expect(pending).resolves.toEqual([]);
  await expect(documents.listWorkspaceFiles("D:/demo")).resolves.toEqual([
    "new.md",
  ]);
  expect(host.listWorkspaceFiles).toHaveBeenCalledTimes(2);
});

it("does not start a queued directory read after its search becomes obsolete", async () => {
  const documents = createTestDocuments();
  const finish: ((result: DirectoryResult) => void)[] = [];
  const directory = vi
    .spyOn(NativePanelService.prototype, "directory")
    .mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const result: DirectoryResult = { entries: [], truncated: false };
  const running = Array.from({ length: 4 }, (_, i) =>
    documents.directory(`D:/demo/${i}`),
  );
  let current = true;
  const queued = documents.directory("D:/old/search", () => current);
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  try {
    expect(directory).toHaveBeenCalledTimes(4);
    current = false;
    finish[0]?.(result);
    await rejected;
    expect(directory).not.toHaveBeenCalledWith("D:/old/search");
  } finally {
    for (const resolve of finish) resolve(result);
    await Promise.all(running);
    documents.dispose();
    directory.mockRestore();
  }
});

it("retires document UI, queued reads, annotation navigation and confirmations on the same root", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  const listing = { entries: [], truncated: false };
  const deferred: ((data: DirectoryResult) => void)[] = [];
  const directory = vi
    .spyOn(NativePanelService.prototype, "directory")
    .mockImplementation((path) =>
      path.startsWith("D:/retired")
        ? new Promise((resolve) => deferred.push(resolve))
        : Promise.resolve(listing),
    );
  const releases = [vi.fn(), vi.fn()];
  const watch = vi
    .spyOn(NativePanelService.prototype, "watch")
    .mockResolvedValueOnce(releases[0]!)
    .mockResolvedValueOnce(releases[1]!);
  let finishStat!: (entry: Awaited<ReturnType<DocumentFileHost["stat"]>>) => void;
  const stat = vi.spyOn(NativePanelService.prototype, "stat").mockReturnValueOnce(
    new Promise((resolve) => { finishStat = resolve; }),
  );
  const focusTarget = document.createElement("button");
  focusTarget.dataset.fileSearchScope = "retired";
  document.body.append(focusTarget);
  const keyboard = new KeyboardEvent("keydown");
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const { documents, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(documentsPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Documents fiber is missing");
    const path = "D:/retired/a.md";
    workbench.navigation.getState().openView("project-overview", "D:/retired");
    const paths = workbench.getSnapshot().pathResolvers[0];
    const openingPath = workbench.openPath("D:/retired", path, 12);
    expect(stat).toHaveBeenCalledWith(path);
    documents.editor.receive(path, "saved");
    documents.editor.edit(path, "unsaved");
    documents.requestAnnotation({
      annotation: {
        id: "retired",
        project: "D:/retired",
        path,
        source: false,
        quote: "saved",
        offset: 0,
        prefix: "",
        suffix: "",
        revision: "initial",
        comment: "",
      },
      target: {},
      draft: false,
    });
    const before = documents.annotationNavigation.getState();
    expect(before?.ready).toBe(false);
    expect(documents.annotationNavigation).not.toHaveProperty("setState");
    const annotationObserver = vi.fn();
    documents.annotationNavigation.subscribe(annotationObserver);
    documents.fileFind.register("retired");
    focusTarget.focus();
    expect(documents.fileFind.owner(keyboard)).toBe("retired");
    expect(unload()).toBe(true);
    const confirm = workbench.navigationGuard.confirm();
    const changed = vi.fn();
    await documents.watch(
      "D:/retired",
      [{ path: "D:/retired", recursive: false }],
      changed,
      vi.fn(),
    );
    const running = Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        documents.directory(`D:/retired/${i}`),
      ),
    );
    const queued = expect(
      documents.directory("D:/retired/queued"),
    ).rejects.toThrow("disposed");

    await fiber.dispose();
    await queued;
    await expect(confirm).resolves.toBe(false);
    expect(unload()).toBe(false);
    expect(workbench.getSnapshot().pathResolvers).toEqual([]);
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).not.toContain(
      "files",
    );
    expect(documents.annotationNavigation.getState()).toBeNull();
    documents.finishAnnotation(before!.nonce);
    expect(annotationObserver).not.toHaveBeenCalled();
    expect(documents.fileFind.owner(keyboard)).toBeNull();
    expect(releases[0]).toHaveBeenCalledOnce();
    watch.mock.calls[0]?.[1]();
    expect(changed).not.toHaveBeenCalled();

    await root.plugin(documentsPlugin);
    const replacement = root.documents;
    expect(workbench.getSnapshot().pathResolvers[0]?.id).toBe("documents");
    expect(workbench.getSnapshot().pathResolvers[0]).not.toBe(paths);
    const entry = { path, name: "a.md", directory: false, symlink: false };
    finishStat(entry);
    await expect(openingPath).resolves.toBe(false);
    const tabs = () => Object.values(workbench.panels.getState().projects).flatMap((panel) => panel.tabs);
    expect(tabs().some(({ data }) => data?.path === path)).toBe(false);
    stat.mockResolvedValueOnce(entry);
    await expect(workbench.openPath("D:/retired", path, 12)).resolves.toBe(true);
    expect(tabs()).toContainEqual(
      expect.objectContaining({ data: { path, line: 12 } }),
    );
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toContain(
      "files",
    );
    expect(replacement.editor.unsaved()).toEqual([]);
    expect(replacement.annotationNavigation.getState()).toBeNull();
    await expect(replacement.directory("D:/replacement")).resolves.toEqual(
      listing,
    );
    for (const finish of deferred) finish(listing);
    expect((await running).map(({ status }) => status)).toEqual(
      Array(4).fill("rejected"),
    );
    expect(directory).not.toHaveBeenCalledWith("D:/retired/queued");
    const stop = await replacement.watch(
      "D:/replacement",
      [{ path: "D:/replacement", recursive: false }],
      changed,
      vi.fn(),
    );
    watch.mock.calls[1]?.[1]();
    expect(changed).toHaveBeenCalledOnce();
    stop();
    expect(releases[1]).toHaveBeenCalledOnce();
  } finally {
    focusTarget.remove();
    for (const finish of deferred) finish(listing);
    await runtime.shutdown();
    directory.mockRestore();
    watch.mockRestore();
    stat.mockRestore();
  }
});
