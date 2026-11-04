import { create } from "zustand";
import { panelService } from "../core/panelService.ts";
import { pathKey } from "../core/panelPaths.ts";

export interface MarkdownDocument {
  path: string;
  base: string;
  text: string;
  conflict: boolean;
  saving: boolean;
  error: string | null;
}
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
interface MarkdownState {
  documents: Record<string, MarkdownDocument>;
  confirmation: boolean;
  promptError: string | null;
  receive: (path: string, raw: string) => void;
  edit: (path: string, text: string) => void;
  discard: (path: string) => void;
  fail: (path: string, message: string) => void;
}
export const useMarkdownDocumentStore = create<MarkdownState>((set) => ({
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
  const doc = useMarkdownDocumentStore.getState().documents[key];
  if (owners.get(key) !== 0 || (doc && (markdownDirty(doc) || doc.saving)))
    return;
  owners.delete(key);
  useMarkdownDocumentStore.setState((state) => {
    const documents = { ...state.documents };
    delete documents[key];
    return { documents };
  });
}
export function retainMarkdownDocument(path: string): () => void {
  const key = pathKey(path);
  owners.set(key, (owners.get(key) ?? 0) + 1);
  return () => {
    owners.set(key, Math.max(0, (owners.get(key) ?? 1) - 1));
    releaseCleanDocument(key);
  };
}

export function saveMarkdownDocument(
  path: string,
  force = false,
): Promise<boolean> {
  const key = pathKey(path),
    current = useMarkdownDocumentStore.getState().documents[key];
  const pending = saves.get(key);
  if (pending) return pending;
  if (!current || (!markdownDirty(current) && !force))
    return Promise.resolve(true);
  const contents = markdownBytes(current);
  useMarkdownDocumentStore.setState((state) => ({
    documents: {
      ...state.documents,
      [key]: { ...current, saving: true, error: null },
    },
  }));
  const task = panelService
    .saveMarkdown(path, current.base, contents, force)
    .then(() => {
      useMarkdownDocumentStore.setState((state) => ({
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
      const message = error instanceof Error ? error.message : String(error);
      useMarkdownDocumentStore.setState((state) => ({
        documents: {
          ...state.documents,
          [key]: {
            ...state.documents[key]!,
            saving: false,
            conflict:
              state.documents[key]!.conflict || message.includes("文件已变化"),
            error: message,
          },
        },
      }));
      return false;
    })
    .finally(() => {
      saves.delete(key);
      releaseCleanDocument(key);
    });
  saves.set(key, task);
  return task;
}
export const markdownUnsaved = (doc: MarkdownDocument) =>
  markdownDirty(doc) || doc.saving;
export const dirtyMarkdownDocuments = () =>
  Object.values(useMarkdownDocumentStore.getState().documents).filter(
    markdownUnsaved,
  );
let decision: {
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
} | null = null;
export function confirmMarkdownNavigation(): Promise<boolean> {
  if (!dirtyMarkdownDocuments().length) return Promise.resolve(true);
  if (decision) return Promise.resolve(false);
  let resolve!: (allowed: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  decision = { promise, resolve };
  useMarkdownDocumentStore.setState({ confirmation: true, promptError: null });
  return promise;
}
export async function settleMarkdownNavigation(
  choice: "save" | "discard" | "cancel",
): Promise<void> {
  if (!decision) return;
  if (choice === "save") {
    for (const doc of dirtyMarkdownDocuments()) {
      const inFlight = saves.get(pathKey(doc.path));
      if (inFlight) await inFlight;
      if (!(await saveMarkdownDocument(doc.path))) {
        useMarkdownDocumentStore.setState({
          promptError: "保存失败，请取消返回文件处理错误或外部修改冲突。",
        });
        return;
      }
    }
    if (dirtyMarkdownDocuments().length) return;
  } else if (choice === "discard") {
    for (const doc of dirtyMarkdownDocuments()) {
      const inFlight = saves.get(pathKey(doc.path));
      if (inFlight) await inFlight;
      useMarkdownDocumentStore.getState().discard(doc.path);
      releaseCleanDocument(pathKey(doc.path));
    }
  }
  const current = decision;
  decision = null;
  useMarkdownDocumentStore.setState({ confirmation: false, promptError: null });
  current.resolve(choice !== "cancel");
}
/** 同步入口在有修改时暂缓整条动作；确认后重新执行，取消则不写任何目标状态。 */
export function guardMarkdownNavigation(action: () => void): boolean {
  if (!dirtyMarkdownDocuments().length) return true;
  // 一次确认只承接一次操作，防止连点后多个导航依次执行。
  if (!decision)
    void confirmMarkdownNavigation().then((allowed) => {
      if (allowed) action();
    });
  return false;
}

export function runMarkdownNavigation(action: () => void): void {
  if (guardMarkdownNavigation(action)) action();
}
