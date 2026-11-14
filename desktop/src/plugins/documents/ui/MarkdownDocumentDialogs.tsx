import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type { DocumentEditor } from "../types.ts";
import type { DocumentsService } from "../service.ts";

import { pathKey, pathName } from "../../../shared/panelPaths.ts";
import { markdownUnsaved } from "../editor/editor.ts";
import {
  DangerButton,
  btnNeutralPrimary,
  btnSecondary,
} from "../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";

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
    <ModalShell label={label} layer="foreground" onDismiss={onCancel}>
      <div ref={root} className="space-y-4 p-5 text-sm leading-relaxed text-ink-soft">
        <h2 className="text-base font-semibold text-ink">{label}</h2>
        {children}
      </div>
    </ModalShell>,
    document.body,
  );
}
export function MarkdownDocumentDialogs({
  editor,
}: {
  editor: DocumentEditor;
}) {
  const open = useStore(editor.state, (state) => state.confirmation);
  const project = useStore(editor.state, (state) => state.confirmationProject);
  const documents = useStore(editor.state, (state) => state.documents);
  const error = useStore(editor.state, (state) => state.promptError);
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
          <li key={doc.path} className="break-all py-1" data-hint={doc.path}>
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
          className={`${btnSecondary} px-3 py-1.5 text-sm whitespace-nowrap`}
          onClick={() => choose("cancel")}
        >
          取消
        </button>
        <DangerButton
          disabled={busy}
          className="px-3 py-1.5 text-sm whitespace-nowrap"
          onClick={() => choose("discard")}
        >
          放弃修改
        </DangerButton>
        <button
          disabled={busy}
          className={`${btnNeutralPrimary} px-3 py-1.5 text-sm whitespace-nowrap`}
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
  const doc = useStore(editor.state, (state) => state.documents[pathKey(path)]);
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
        editor.discard(path);
        editor.receive(path, disk.content);
        setDecision(null);
      }
    } catch (error) {
      editor.fail(path, String(error));
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
            <DangerButton
              className="px-2 py-1"
              disabled={doc.saving}
              onClick={() => setDecision("overwrite")}
            >
              覆盖保存…
            </DangerButton>
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
              className={`${btnSecondary} px-3 py-1.5 text-sm whitespace-nowrap`}
              onClick={() => setDecision(null)}
            >
              取消
            </button>
            <DangerButton
              disabled={busy}
              className="px-3 py-1.5 text-sm whitespace-nowrap"
              onClick={() => {
                void execute();
              }}
            >
              {busy
                ? "处理中…"
                : decision === "reload"
                  ? "放弃并重新载入"
                  : "覆盖保存"}
            </DangerButton>
          </div>
        </DocumentDialog>
      ) : null}
    </>
  );
}
