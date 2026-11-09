import { createStore } from "zustand";
import type {
  DocumentEditor,
  DocumentFileHost,
  MarkdownDocument,
  MarkdownState,
} from "../../contracts/documents.ts";
import { insidePath, pathKey } from "../../shared/panelPaths.ts";

export const markdownText = (raw: string) =>
  raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
export const markdownDirty = (doc: MarkdownDocument) =>
  doc.text !== markdownText(doc.base);
export function markdownBytes(doc: MarkdownDocument, text = doc.text): string {
  return (
    (doc.base.startsWith("\uFEFF") ? "\uFEFF" : "") +
    text.replace(/\r?\n/g, doc.base.includes("\r\n") ? "\r\n" : "\n")
  );
}
export const markdownUnsaved = (doc: MarkdownDocument) =>
  markdownDirty(doc) || doc.saving;

export function createMarkdownEditor(
  files: Pick<DocumentFileHost, "saveMarkdown">,
): DocumentEditor & {
  releaseProject(project: string): void;
  dispose(): void;
} {
  let disposed = false;
  const projects = new Map<string, Set<string>>();
  const store = createStore<MarkdownState>((set) => ({
    documents: {},
    confirmation: false,
    promptError: null,
    receive: (path, base) =>
      set((state) => {
        const key = pathKey(path),
          previous = state.documents[key];
        if (previous?.saving) return {};
        const dirty = previous && markdownDirty(previous);
        const next: MarkdownDocument = dirty
          ? { ...previous, conflict: base !== previous.base, error: null }
          : {
              path,
              base,
              text: markdownText(base),
              conflict: false,
              saving: false,
              error: null,
            };
        return { documents: { ...state.documents, [key]: next } };
      }),
    edit: (path, text) =>
      set((state) => {
        const key = pathKey(path),
          doc = state.documents[key];
        return doc
          ? { documents: { ...state.documents, [key]: { ...doc, text } } }
          : {};
      }),
    discard: (path) =>
      set((state) => {
        const key = pathKey(path),
          doc = state.documents[key];
        return doc
          ? {
              documents: {
                ...state.documents,
                [key]: {
                  ...doc,
                  text: markdownText(doc.base),
                  error: null,
                  conflict: false,
                },
              },
            }
          : {};
      }),
    fail: (path, error) =>
      set((state) => {
        const key = pathKey(path),
          doc = state.documents[key];
        return doc
          ? { documents: { ...state.documents, [key]: { ...doc, error } } }
          : {};
      }),
  }));
  const saves = new Map<string, Promise<boolean>>();
  const owners = new Map<string, number>();
  function releaseCleanDocument(key: string) {
    const doc = store.getState().documents[key];
    if (owners.get(key) !== 0 || (doc && (markdownDirty(doc) || doc.saving)))
      return;
    owners.delete(key);
    projects.delete(key);
    store.setState((state) => {
      const documents = { ...state.documents };
      delete documents[key];
      return { documents };
    });
  }
  function retain(path: string, project?: string): () => void {
    const key = pathKey(path);
    if (disposed) return () => {};
    owners.set(key, (owners.get(key) ?? 0) + 1);
    if (project) {
      const scopes = projects.get(key) ?? new Set<string>();
      scopes.add(pathKey(project));
      projects.set(key, scopes);
    }
    let released = false;
    return () => {
      if (released || disposed) return;
      released = true;
      owners.set(key, Math.max(0, (owners.get(key) ?? 1) - 1));
      releaseCleanDocument(key);
    };
  }

  function save(path: string, force = false): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const key = pathKey(path),
      current = store.getState().documents[key];
    const pending = saves.get(key);
    if (pending) return pending;
    if (!current || (!markdownDirty(current) && !force))
      return Promise.resolve(true);
    const contents = markdownBytes(current);
    store.setState((state) => ({
      documents: {
        ...state.documents,
        [key]: { ...current, saving: true, error: null },
      },
    }));
    const task = files
      .saveMarkdown(path, current.base, contents, force)
      .then(() => {
        if (disposed) return false;
        store.setState((state) => ({
          documents: {
            ...state.documents,
            [key]: {
              ...state.documents[key]!,
              base: contents,
              saving: false,
              conflict: false,
              error: null,
            },
          },
        }));
        return true;
      })
      .catch((error: unknown) => {
        if (disposed) return false;
        const message = error instanceof Error ? error.message : String(error);
        store.setState((state) => ({
          documents: {
            ...state.documents,
            [key]: {
              ...state.documents[key]!,
              saving: false,
              conflict:
                state.documents[key]!.conflict ||
                message.includes("文件已变化"),
              error: message,
            },
          },
        }));
        return false;
      })
      .finally(() => {
        saves.delete(key);
        if (!disposed) releaseCleanDocument(key);
      });
    saves.set(key, task);
    return task;
  }

  function unsaved(project?: string): MarkdownDocument[] {
    return Object.values(store.getState().documents).filter(
      (doc) =>
        markdownUnsaved(doc) &&
        (project === undefined ||
          projects.get(pathKey(doc.path))?.has(pathKey(project)) ||
          insidePath(project, doc.path)),
    );
  }

  let decision:
    { project?: string; resolve(allowed: boolean): void } | undefined;
  function confirm(project?: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (!unsaved(project).length) return Promise.resolve(true);
    if (decision) return Promise.resolve(false);
    return new Promise((resolve) => {
      decision = { project, resolve };
      store.setState({
        confirmation: true,
        confirmationProject: project,
        promptError: null,
      });
    });
  }

  async function settle(choice: "save" | "discard" | "cancel"): Promise<void> {
    const pending = decision;
    if (!pending) return;
    if (choice !== "cancel") {
      for (const doc of unsaved(pending.project)) {
        const key = pathKey(doc.path);
        const inFlight = saves.get(key);
        if (inFlight) await inFlight;
        if (decision !== pending) return;
        if (choice === "discard") {
          store.getState().discard(doc.path);
          releaseCleanDocument(key);
        } else if (!(await save(doc.path))) {
          if (decision === pending)
            store.setState({
              promptError: "保存失败，请取消返回文件处理错误或外部修改冲突。",
            });
          return;
        }
      }
      if (decision !== pending) return;
      if (choice === "save" && unsaved(pending.project).length) return;
    }
    decision = undefined;
    store.setState({
      confirmation: false,
      confirmationProject: undefined,
      promptError: null,
    });
    pending.resolve(choice !== "cancel");
  }

  function guard(action: () => void, project?: string): boolean {
    if (disposed) return false;
    if (!unsaved(project).length) return true;
    if (!decision)
      void confirm(project).then((allowed) => {
        if (allowed && !disposed) action();
      });
    return false;
  }

  return {
    store,
    retain,
    save,
    unsaved,
    confirm,
    settle,
    guard,
    releaseProject(project) {
      const scope = pathKey(project);
      for (const [key, scopes] of projects) {
        const document = store.getState().documents[key];
        if (scopes.has(scope) && (!document || !markdownUnsaved(document))) {
          scopes.delete(scope);
          releaseCleanDocument(key);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      decision?.resolve(false);
      decision = undefined;
      owners.clear();
      saves.clear();
      projects.clear();
      store.setState({
        documents: {},
        confirmation: false,
        confirmationProject: undefined,
        promptError: null,
      });
    },
  };
}
