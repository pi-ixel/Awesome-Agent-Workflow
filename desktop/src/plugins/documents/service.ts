import { createStore } from "zustand";
import type {
  AnnotationRequest,
  DocumentFileHost,
  DocumentsService,
} from "../../contracts/documents.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";
import { createFileFind } from "./fileFind.ts";
import { createMarkdownEditor } from "./editor.ts";

const logger = createLogger("documents");
export const DIRECTORY_READ_CONCURRENCY = 4;
const FILE_LIST_TTL_MS = 30_000;

export function createDocuments(
  files: DocumentFileHost,
): DocumentsService & { dispose(): void } {
  const editor = createMarkdownEditor(files);
  const fileFind = createFileFind(
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
  const annotationNavigation = createStore<AnnotationRequest | null>(
    () => null,
  );
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
    annotationNavigation,
    isActive: () => !disposed,
    requestAnnotation(destination) {
      if (!disposed)
        annotationNavigation.setState({
          ...destination,
          nonce: ++annotationNonce,
          ready: false,
        });
    },
    finishAnnotation(nonce) {
      const current = annotationNavigation.getState();
      if (!disposed && current?.nonce === nonce && !current.ready)
        annotationNavigation.setState({ ...current, ready: true });
    },
    clearAnnotation(nonce) {
      if (!disposed && annotationNavigation.getState()?.nonce === nonce)
        annotationNavigation.setState(null);
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
      const navigation = annotationNavigation.getState();
      if (navigation && pathKey(navigation.annotation.project) === key)
        annotationNavigation.setState(null);
      editor.releaseProject(project);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      index.clear();
      annotationNavigation.setState(null);
      for (const resume of queuedDirectories.splice(0)) resume();
      for (const release of watches.keys()) release();
      fileFind.dispose();
      editor.dispose();
    },
  };
}
