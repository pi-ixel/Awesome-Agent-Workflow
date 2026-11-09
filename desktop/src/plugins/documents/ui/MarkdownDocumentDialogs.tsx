import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type {
  DocumentEditor,
  DocumentsService,
} from "../../../contracts/documents.ts";

import { pathKey, pathName } from "../../../shared/panelPaths.ts";
import { markdownUnsaved } from "../editor.ts";
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
} from "../../../shared/ui/controls.tsx";

function DocumentDialog({
  label,
  onCancel,
  children,
}: {
  label: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null),
    cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.current();
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        if (!buttons.length) return;
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        event.preventDefault();
        buttons[
          (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => {
      window.removeEventListener("keydown", handle, true);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-surface p-5 text-ui-base text-ink shadow-md"
      >
        <h2 className="mb-3 text-ui-base font-semibold">{label}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function MarkdownDocumentDialogs({
  editor,
}: {
  editor: DocumentEditor;
}) {
  const open = useStore(editor.store, (state) => state.confirmation);
  const project = useStore(editor.store, (state) => state.confirmationProject);
  const documents = useStore(editor.store, (state) => state.documents);
  const error = useStore(editor.store, (state) => state.promptError);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const unsaved =
    project === undefined
      ? Object.values(documents).filter(markdownUnsaved)
      : editor.unsaved(project);
  const choose = (choice: "save" | "discard" | "cancel") => {
    if (busy) return;
    setBusy(true);
    void editor.settle(choice).finally(() => setBusy(false));
  };
  return (
    <DocumentDialog
      label="保存 Markdown 修改？"
      onCancel={() => choose("cancel")}
    >
      <p className="text-ink-subtle">
        以下文件尚未保存，继续切换或关闭前请选择如何处理。
      </p>
      <ul className="my-3 max-h-40 overflow-auto">
        {unsaved.map((doc) => (
          <li key={doc.path} className="break-all py-1" title={doc.path}>
            {pathName(doc.path)}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mb-3 text-danger-ink">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          data-cancel
          disabled={busy}
          className={`${btnSecondary} px-3 py-1.5`}
          onClick={() => choose("cancel")}
        >
          取消
        </button>
        <button
          disabled={busy}
          className={`${btnDanger} px-3 py-1.5`}
          onClick={() => choose("discard")}
        >
          放弃修改
        </button>
        <button
          disabled={busy}
          className={`${btnPrimary} px-3 py-1.5`}
          onClick={() => choose("save")}
        >
          {busy ? "正在保存…" : "保存"}
        </button>
      </div>
    </DocumentDialog>
  );
}
export function MarkdownConflictActions({
  documents,
  path,
}: {
  documents: DocumentsService;
  path: string;
}) {
  const { editor } = documents;
  const doc = useStore(editor.store, (state) => state.documents[pathKey(path)]);
  const [decision, setDecision] = useState<"reload" | "overwrite" | null>(null),
    [busy, setBusy] = useState(false);
  if (!doc) return null;
  const execute = async () => {
    setBusy(true);
    try {
      if (decision === "overwrite") {
        if (await editor.save(path, true)) setDecision(null);
      } else {
        const disk = await documents.preview(path);
        if (disk.kind !== "text")
          throw new Error("文件不再是文本，未放弃编辑内容");
        editor.store.getState().discard(path);
        editor.store.getState().receive(path, disk.content);
        setDecision(null);
      }
    } catch (error) {
      editor.store.getState().fail(path, String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {doc.conflict || doc.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-ui-sm text-danger-ink"
        >
          <span className="min-w-0 flex-1 break-words">
            {doc.conflict ? "磁盘文件已变化，本地编辑已保留。" : doc.error}
          </span>
          <button
            className={`${btnSecondary} px-2 py-1`}
            disabled={doc.saving}
            onClick={() => setDecision("reload")}
          >
            重新载入
          </button>
          {doc.conflict ? (
            <button
              className={`${btnDanger} px-2 py-1`}
              disabled={doc.saving}
              onClick={() => setDecision("overwrite")}
            >
              覆盖保存…
            </button>
          ) : null}
        </div>
      ) : null}
      {decision ? (
        <DocumentDialog
          label={
            decision === "reload"
              ? "放弃本地修改并重新载入？"
              : "覆盖磁盘文件？"
          }
          onCancel={() => {
            if (!busy) setDecision(null);
          }}
        >
          <p className="mb-4 break-all">{path}</p>
          <p className="mb-4 text-ink-subtle">
            {decision === "reload"
              ? "重新载入将放弃此文件未保存的编辑。"
              : "磁盘上其他程序的修改将被当前编辑内容替换。"}
          </p>
          {doc.error ? (
            <p className="mb-3 text-danger-ink">{doc.error}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              data-cancel
              disabled={busy}
              className={`${btnSecondary} px-3 py-1.5`}
              onClick={() => setDecision(null)}
            >
              取消
            </button>
            <button
              disabled={busy}
              className={`${btnDanger} px-3 py-1.5`}
              onClick={() => {
                void execute();
              }}
            >
              {busy
                ? "处理中…"
                : decision === "reload"
                  ? "放弃并重新载入"
                  : "覆盖保存"}
            </button>
          </div>
        </DocumentDialog>
      ) : null}
    </>
  );
}
