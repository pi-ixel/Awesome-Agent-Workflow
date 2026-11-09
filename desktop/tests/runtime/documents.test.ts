import type { Context } from "cordis";
import * as documentsPlugin from "../../src/plugins/documents/plugin.ts";
import { expect, it, vi } from "vitest";
import type {
  DirectoryResult,
  DocumentFileHost,
} from "../../src/contracts/documents.ts";
import { createDocuments } from "../../src/plugins/documents/service.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { panelService } from "../../src/plugins/host/panelService.ts";
import { createTestDocuments } from "../helpers/documents.ts";

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
    expect(workbench.getSnapshot().documents[0]?.service).toBe(documents);
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["files", "file", "directory"]),
    );
    expect(workbench.getSnapshot().chrome.map(({ id }) => id)).toContain(
      "documents-dialogs",
    );
    const { editor } = documents;
    const edit = (path: string) => {
      editor.store.getState().receive(path, "saved");
      editor.store.getState().edit(path, "edited");
    };
    const external = "E:/shared/readme.md";
    const other = "D:/other/readme.md";
    // Keep an external edit associated with its owning project after the tab unmounts.
    const release = editor.retain(external, "D:/demo");
    edit(external);
    release();
    edit(other);
    expect(workbench.navigationGuard.pending()).toBe(true);
    const cancelled = project.closeProject("D:/demo");
    expect(project.closeProject("d:\\DEMO")).toBe(cancelled);
    await vi.waitFor(() =>
      expect(editor.store.getState().confirmationProject).toBe("D:/demo"),
    );
    expect(closeProject).not.toHaveBeenCalled();
    expect(editor.unsaved("D:/demo").map(({ path }) => path)).toEqual([
      external,
    ]);
    await editor.settle("cancel");
    await cancelled;
    expect(closeProject).not.toHaveBeenCalled();
    expect(editor.unsaved()).toHaveLength(2);

    const accepted = project.closeProject("D:/demo");
    await vi.waitFor(() =>
      expect(editor.store.getState().confirmation).toBe(true),
    );
    await editor.settle("discard");
    await accepted;
    expect(closeProject).toHaveBeenCalledExactlyOnceWith("D:/demo");
    expect(editor.unsaved().map(({ path }) => path)).toEqual([other]);
    await runtime.shutdown();
    expect(editor.store.getState().documents).toEqual({});
    expect(workbench.getSnapshot().panels).toEqual([]);
  } finally {
    await runtime.shutdown();
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
  editor.store.getState().receive(path, "saved");
  editor.store.getState().edit(path, "edited");
  const save = editor.save(path);
  const check = editor.confirm();
  documents.dispose();
  await expect(check).resolves.toBe(false);
  finish();
  await expect(save).resolves.toBe(false);
  expect(editor.store.getState()).toMatchObject({
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
    .spyOn(panelService, "directory")
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
    .spyOn(panelService, "directory")
    .mockImplementation((path) =>
      path.startsWith("D:/retired")
        ? new Promise((resolve) => deferred.push(resolve))
        : Promise.resolve(listing),
    );
  const releases = [vi.fn(), vi.fn()];
  const watch = vi
    .spyOn(panelService, "watch")
    .mockResolvedValueOnce(releases[0]!)
    .mockResolvedValueOnce(releases[1]!);
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
    documents.editor.store.getState().receive(path, "saved");
    documents.editor.store.getState().edit(path, "unsaved");
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
      scope: "retired",
      draft: false,
    });
    const before = documents.annotationNavigation.getState();
    expect(before?.ready).toBe(false);
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
    expect(workbench.getSnapshot().documents).toEqual([]);
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).not.toContain(
      "files",
    );
    expect(documents.annotationNavigation.getState()).toBeNull();
    expect(documents.fileFind.owner(keyboard)).toBeNull();
    expect(releases[0]).toHaveBeenCalledOnce();
    watch.mock.calls[0]?.[1]();
    expect(changed).not.toHaveBeenCalled();

    await root.plugin(documentsPlugin);
    const replacement = root.documents;
    expect(workbench.getSnapshot().documents[0]?.service).toBe(replacement);
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
  }
});
