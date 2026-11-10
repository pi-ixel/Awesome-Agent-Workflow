import { createStore } from "zustand";
import type { AnnotationRequest } from "../types.ts";
import type { DocumentsService } from "../service.ts";
import type { DocumentFileHost } from "../../host/types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import { createFileFind } from "../search/fileFind.ts";
import { createMarkdownEditor } from "../editor/editor.ts";
import { DIRECTORY_READ_CONCURRENCY } from "../config.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

const FILE_LIST_TTL_MS = 30_000;

export function createDocuments(
  files: DocumentFileHost,
  logger = createLogger("documents"),
): DocumentsService & { dispose(this: void): void } {
  const { dispose: disposeEditor, releaseProject: releaseEditorProject, ...editor } =
    createMarkdownEditor(files);
  const { dispose: disposeFileFind, ...fileFind } = createFileFind(
    typeof document === "undefined" ? undefined : document,
  );
  const watches = new Map<() => void, string>();
  const index = new Map<
    string,
    { task: Promise<readonly string[]>; expiresAt: number }
  >();
  let disposed = false;
  let runningDirectories = 0;
  const queuedDirectories: (() => void)[] = [];
  const navigation = createStore<{ request: AnnotationRequest | null }>(() => ({ request: null }));
  const annotationNavigation = createSnapshotView(navigation, ({ request }) => request);
  const setAnnotation = (request: AnnotationRequest | null) => navigation.setState({ request });
  let annotationNonce = 0;
  const assertOpen = () => {
    if (disposed) throw new Error("Documents service is disposed");
  };
  async function read<T>(request: () => Promise<T>): Promise<T> {
    assertOpen();
    const result = await request();
    assertOpen();
    return result;
  }

  return {
    editor,
    fileFind,
    annotationNavigation: annotationNavigation.snapshot,
    isActive: () => !disposed,
    requestAnnotation(destination) {
      if (!disposed)
        setAnnotation({
          ...destination,
          nonce: ++annotationNonce,
          ready: false,
        });
    },
    finishAnnotation(nonce) {
      const { request: current } = navigation.getState();
      if (!disposed && current?.nonce === nonce && !current.ready)
        setAnnotation({ ...current, ready: true });
    },
    clearAnnotation(nonce) {
      if (!disposed && navigation.getState().request?.nonce === nonce)
        setAnnotation(null);
    },
    stat: (path) => read(() => files.stat(path)),
    openInFileManager: (path, mode) => read(() => files.openInFileManager(path, mode)),
    assetUrl: (path) => disposed ? undefined : files.assetUrl(path),
    async directory(path, isCurrent = () => true) {
      assertOpen();
      if (runningDirectories >= DIRECTORY_READ_CONCURRENCY) {
        await new Promise<void>((resume) => queuedDirectories.push(resume));
      } else {
        runningDirectories += 1;
      }
      try {
        if (!isCurrent())
          throw new DOMException("Directory read superseded", "AbortError");
        return await read(() => files.directory(path));
      } finally {
        const next = queuedDirectories.shift();
        if (next) next();
        else if (!disposed) runningDirectories -= 1;
      }
    },
    preview: (path) => read(() => files.preview(path)),
    async listWorkspaceFiles(project) {
      const root = project.trim();
      if (disposed || !root) return [];
      const key = pathKey(root);
      const cached = index.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.task;
      const task = files
        .listWorkspaceFiles(root)
        .catch((error: unknown) => {
          logger.debug("文件列举失败", {
            workspacePath: root,
            reason: String(error),
          });
          return null;
        })
        .then((paths) => {
          const entry = index.get(key);
          if (entry?.task !== task) return [];
          if (paths === null) index.delete(key);
          else entry.expiresAt = Date.now() + FILE_LIST_TTL_MS;
          return paths ?? [];
        });
      index.set(key, { task, expiresAt: Infinity });
      return task;
    },
    async watch(project, paths, changed, failed) {
      assertOpen();
      let stop: (() => void) | undefined;
      const release = () => {
        if (watches.delete(release)) stop?.();
      };
      watches.set(release, pathKey(project));
      try {
        stop = await files.watch(
          paths,
          () => {
            if (watches.has(release)) changed();
          },
          (error) => {
            if (watches.has(release)) failed(error);
          },
        );
        if (!watches.has(release)) stop();
        return release;
      } catch (error) {
        if (!watches.delete(release)) return release;
        throw error;
      }
    },
    releaseProject(project) {
      const key = pathKey(project);
      index.delete(key);
      for (const [release, owner] of watches) {
        if (key === owner) release();
      }
      const { request } = navigation.getState();
      if (request && pathKey(request.annotation.project) === key)
        setAnnotation(null);
      releaseEditorProject(project);
    },
    dispose(this: void) {
      if (disposed) return;
      disposed = true;
      index.clear();
      annotationNavigation.dispose();
      setAnnotation(null);
      for (const resume of queuedDirectories.splice(0)) resume();
      for (const release of watches.keys()) release();
      disposeFileFind();
      disposeEditor();
    },
  };
}
