import {
  readWorkbenchUi,
  useWorkbenchLayout,
  useSessionValue,
  useConversation,
  useWorkbenchProject,
  useAnnotationDraft,
  useAnnotationDraftService,
  useWorkspaceValue,
} from "../../workbench/viewBindings.ts";
import type { MarkdownEditorApi } from "./MarkdownSourceEditor.tsx";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  documentRevision,
  locateAnnotation,
  QUOTE_LIMIT,
  COMMENT_LIMIT,
  type DocumentAnnotation,
} from "../../../contracts/documentAnnotations.ts";
import { useStore } from "zustand";
import type { DocumentsService } from "../../../contracts/documents.ts";
import type { AnnotationDraftService } from "../../../contracts/annotationDrafts.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { draftScopeKey } from "../../../contracts/draftScope.ts";
import { documentTextIndex } from "./documentAnnotationIndex.ts";

interface Editor {
  readonly owner: AnnotationDraftService;
  readonly annotation: DocumentAnnotation;
  readonly scope: string;
  readonly x: number;
  readonly y: number;
  readonly open: boolean;
}

/** Keep both the selection action and its editor inside the visible document. */
function overlayPosition(
  root: HTMLElement | null,
  x: number,
  y: number,
  open: boolean,
) {
  const bounds = root?.getBoundingClientRect();
  const left = Math.max(8, (bounds?.left ?? 0) + 8);
  const right = Math.min(
    window.innerWidth - 8,
    (bounds?.right ?? window.innerWidth) - 8,
  );
  const top = Math.max(8, (bounds?.top ?? 0) + 8);
  const bottom = Math.min(
    window.innerHeight - 8,
    (bounds?.bottom ?? window.innerHeight) - 8,
  );
  const width = Math.min(open ? 304 : 64, Math.max(64, right - left));
  return {
    x: Math.max(left, Math.min(x, right - width)),
    y: Math.max(top, Math.min(y, bottom - (open ? 260 : 30))),
  };
}
export function FileAnnotations({
  documents,
  root,
  project,
  path,
  text,
  source,
  instance,
  reveal,
  sourceEditor,
}: {
  documents: DocumentsService;
  root: RefObject<HTMLDivElement | null>;
  project: string;
  path: string;
  text: string;
  source: boolean;
  instance: string;
  reveal: (line: number) => void;
  sourceEditor?: MarkdownEditorApi | null;
}) {
  const workbenchLayout = useWorkbenchLayout();
  const projectService = useWorkbenchProject();
  const foregroundSession = useConversation()?.session;
  const activePath = useWorkspaceValue((s) => s.activePath);
  const sessionId = useSessionValue(
    (s) => s.openingSessionId ?? s.activeSessionId,
  );
  const agentKey = useSessionValue((s) => s.agentKey);
  const currentScope = draftScopeKey(
    pathKey(activePath ?? "") === pathKey(project) && activePath
      ? activePath
      : project,
    pathKey(activePath ?? "") === pathKey(project) ? sessionId : null,
    agentKey,
  );
  const annotationDrafts = useAnnotationDraftService();
  const { annotations } = useAnnotationDraft(annotationDrafts, currentScope);
  const items = useMemo(
    () =>
      annotations.filter(
        (a) => pathKey(a.path) === pathKey(path) && a.source === source,
      ),
    [annotations, path, source],
  );
  const request = useStore(documents.annotationNavigation);
  const requestAnnotation =
    request &&
    request.ready &&
    request.scope === currentScope &&
    (!request.draft ||
      annotations.some((a) => a.id === request.annotation.id)) &&
    pathKey(request.annotation.project) === pathKey(project) &&
    pathKey(request.annotation.path) === pathKey(path) &&
    request.annotation.source === source
      ? request.annotation
      : null;
  const [editorState, setEditor] = useState<Editor | null>(null);
  const editor = editorState?.owner === annotationDrafts ? editorState : null;
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useMemo(() => documentRevision(text), [text]);
  const highlightName = `annotation-${instance.replace(/[^a-z0-9]/gi, "")}`;

  useEffect(() => {
    const element = root.current;
    if (!element || !annotationDrafts) return;
    let lineStart: number | null = null;
    const down = (event: PointerEvent) => {
      const node = event.target instanceof Element ? event.target : null;
      if (source && node?.matches("[data-annotation-line]")) {
        lineStart = Number(node.getAttribute("data-annotation-line"));
        event.preventDefault();
      }
    };
    const select = (event: PointerEvent | KeyboardEvent) => {
      const selection = window.getSelection();
      if (lineStart !== null && event instanceof PointerEvent) {
        const end = Number(
          (event.target as Element)
            .closest("[data-file-line]")
            ?.getAttribute("data-file-line") ?? lineStart,
        );
        const first = element.querySelector(
          `[data-file-line="${Math.min(lineStart, end)}"] code`,
        );
        const last = element.querySelector(
          `[data-file-line="${Math.max(lineStart, end)}"] code`,
        );
        lineStart = null;
        if (first && last) {
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(last, last.childNodes.length);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setEditor((current) => (current?.open ? current : null));
        return;
      }
      const selected = selection.getRangeAt(0);
      if (
        !element.contains(selected.startContainer) ||
        !element.contains(selected.endContainer)
      )
        return;
      const codeSelection = sourceEditor?.selection();
      const index = codeSelection
          ? {
              text,
              selection: () => ({
                start: codeSelection.from,
                end: codeSelection.to,
              }),
            }
          : documentTextIndex(element),
        offsets = index.selection(selected);
      if (!offsets) return;
      const quote = index.text.slice(offsets.start, offsets.end);
      if (!quote.trim()) return;
      if (quote.length > QUOTE_LIMIT) {
        setNotice("选区最多 10000 字，请缩小范围");
        return;
      }
      const rect =
        Array.from(selected.getClientRects())
          .filter((r) => r.width > 0)
          .at(-1) ?? selected.getBoundingClientRect();
      const row = (node: Node) =>
        (node instanceof Element ? node : node.parentElement)?.closest(
          "[data-file-line]",
        );
      let startLine = source
        ? Number(
            row(selected.startContainer)?.getAttribute("data-file-line"),
          ) || undefined
        : undefined;
      let endLine = source
        ? Number(row(selected.endContainer)?.getAttribute("data-file-line")) ||
          startLine
        : undefined;
      if (codeSelection) {
        startLine = codeSelection.startLine;
        endLine = codeSelection.endLine;
      }
      if (!startLine) {
        const at = text.indexOf(quote);
        if (at >= 0 && text.indexOf(quote, at + 1) === -1) {
          startLine = text.slice(0, at).split("\n").length;
          endLine = startLine + quote.split("\n").length - 1;
        }
      }
      setEditor({
        owner: annotationDrafts,
        scope: currentScope,
        ...overlayPosition(
          element,
          element.getBoundingClientRect().left + 8,
          rect.bottom + 6,
          false,
        ),
        open: false,
        annotation: {
          id: crypto.randomUUID(),
          project,
          path,
          source,
          quote,
          prefix: index.text.slice(
            Math.max(0, offsets.start - 64),
            offsets.start,
          ),
          suffix: index.text.slice(offsets.end, offsets.end + 64),
          offset: offsets.start,
          revision,
          startLine,
          endLine,
          comment: "",
        },
      });
      setComment("");
      setNotice("");
    };
    const clearSelectionButton = () => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !selection.rangeCount ||
        !element.contains(selection.getRangeAt(0).commonAncestorContainer)
      ) {
        setEditor((current) => (current?.open ? current : null));
      }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !element.contains(target) &&
        !target.closest("[data-annotation-overlay]")
      )
        setEditor((current) => (current?.open ? current : null));
    };
    document.addEventListener("selectionchange", clearSelectionButton);
    document.addEventListener("pointerdown", outside);
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointerup", select);
    element.addEventListener("keyup", select);
    return () => {
      document.removeEventListener("selectionchange", clearSelectionButton);
      document.removeEventListener("pointerdown", outside);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointerup", select);
      element.removeEventListener("keyup", select);
    };
  }, [root, project, path, source, currentScope, revision, text, sourceEditor, annotationDrafts]);

  useEffect(
    () =>
      annotationDrafts?.subscribe((state, previous) => {
        if (!editor) return;
        const target = state.migrations[editor.scope];
        if (target && target !== previous.migrations[editor.scope])
          setEditor((current) =>
            current ? { ...current, scope: target } : null,
          );
      }),
    [editor, annotationDrafts],
  );

  useEffect(() => {
    const nonce = request?.nonce;
    if (!requestAnnotation || nonce === undefined) return;
    const timer = setTimeout(() => documents.clearAnnotation(nonce), 3000);
    return () => clearTimeout(timer);
  }, [documents, requestAnnotation, request?.nonce]);

  useEffect(() => {
    if (!editor) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setEditor(null);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [editor]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    if (source && requestAnnotation?.endLine) reveal(requestAnnotation.endLine);
    let jumped = false;
    if (sourceEditor && requestAnnotation) {
      const offset = locateAnnotation(text, requestAnnotation, revision);
      if (offset !== null) {
        sourceEditor.select(offset, offset + requestAnnotation.quote.length);
        jumped = true;
      }
    }
    let frame = 0;
    let hits: { annotation: DocumentAnnotation; range: Range }[] = [];
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const index = sourceEditor
          ? { text, range: sourceEditor.range }
          : documentTextIndex(element);
        hits = [];
        const all =
          requestAnnotation && !items.some((a) => a.id === requestAnnotation.id)
            ? [...items, requestAnnotation]
            : items;
        for (const a of all) {
          const offset = locateAnnotation(index.text, a, revision);
          const range =
            offset === null
              ? null
              : index.range(offset, offset + a.quote.length);
          if (range) hits.push({ annotation: a, range });
        }
        if (
          typeof CSS !== "undefined" &&
          CSS.highlights &&
          typeof Highlight !== "undefined"
        ) {
          const highlight = new Highlight(...hits.map((h) => h.range));
          highlight.priority = -1; // Search's active match stays readable above annotations.
          CSS.highlights.set(highlightName, highlight);
        }
        if (requestAnnotation && !jumped) {
          const hit = hits.find(
            (h) => h.annotation.id === requestAnnotation.id,
          );
          if (hit) {
            hit.range.startContainer.parentElement?.scrollIntoView?.({
              block: "center",
            });
            setNotice("");
            jumped = true;
          } else
            setNotice("原文已变化或无法唯一定位，引用卡片仍保留添加时的原文。");
        }
      });
    };
    const click = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const hit = hits.find(
        (h) =>
          items.some((a) => a.id === h.annotation.id) &&
          Array.from(h.range.getClientRects()).some(
            (r) =>
              event.clientX >= r.left &&
              event.clientX <= r.right &&
              event.clientY >= r.top &&
              event.clientY <= r.bottom,
          ),
      );
      if (!hit || !annotationDrafts) return;
      setComment(hit.annotation.comment);
      setEditor({
        owner: annotationDrafts,
        annotation: hit.annotation,
        scope: currentScope,
        ...overlayPosition(element, event.clientX, event.clientY + 8, true),
        open: true,
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    element.addEventListener("click", click);
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("click", click);
      cancelAnimationFrame(frame);
      if (typeof CSS !== "undefined") CSS.highlights?.delete(highlightName);
    };
  }, [
    root,
    items,
    requestAnnotation,
    currentScope,
    revision,
    highlightName,
    text,
    sourceEditor,
    reveal,
    source,
    annotationDrafts,
  ]);

  function save() {
    if (!editor || !annotationDrafts) return;
    const store = annotationDrafts.getState();
    store.ensure(editor.scope);
    const current =
      store.drafts[editor.scope]?.annotations ??
      annotationDrafts.getState().drafts[editor.scope]?.annotations ??
      [];
    const next = { ...editor.annotation, comment: comment.trim() };
    const updated = current.some((a) => a.id === next.id)
      ? current.map((a) => (a.id === next.id ? next : a))
      : [...current, next];
    if (!store.put(editor.scope, updated)) {
      setNotice(annotationDrafts.getState().error ?? "批注未保存");
      return;
    }
    setEditor(null);
    window.getSelection()?.removeAllRanges();
    const stillCurrent = editor.scope === currentScope;
    setNotice(stillCurrent ? "已添加到会话输入框" : "已保存到原会话草稿");
    if (!stillCurrent) return;
    if (
      pathKey(activePath ?? "") === pathKey(project) &&
      foregroundSession?.getState().isBound
    ) {
      readWorkbenchUi(workbenchLayout).openSessionView(project);
    } else if (
      sessionId === null ||
      pathKey(activePath ?? "") !== pathKey(project)
    ) {
      void projectService?.startNewSession(project)
        .then((result) => {
          if (!result.ok) setNotice(`批注已保存。${result.reason}`);
        })
        .catch(() =>
          setNotice("批注已保存，连接失败，请稍后打开该项目的新会话。"),
        );
    }
  }
  return (
    <>
      <style>{`::highlight(${highlightName}) { background: #facc1538; text-decoration: underline #ca8a04; }`}</style>
      {notice && (
        <div
          role="status"
          className="flex items-center justify-between border-b border-line px-3 py-1 text-ui-caption text-ink-mute"
          data-file-find-ignore
        >
          {notice}
          <button
            type="button"
            aria-label="关闭批注提示"
            onClick={() => setNotice("")}
          >
            ×
          </button>
        </div>
      )}
      {editor &&
        createPortal(
          <div
            data-file-find-ignore
            data-annotation-overlay
            className={`fixed z-[100] max-w-[calc(100vw-16px)] border border-line bg-surface text-ink ${editor.open ? "rounded-xl p-2.5 text-ui-base" : "annotation-rainbow-border rounded-md p-0.5 text-ui-caption"}`}
            style={{
              left: editor.x,
              top: editor.y,
              width: editor.open ? 304 : undefined,
            }}
          >
            {editor.open ? (
              <div role="dialog" aria-label="文档批注">
                <p className="mb-2 truncate text-ui-caption text-ink-mute">
                  {editor.annotation.path.split(/[\\/]/).at(-1)}
                  <span className="ml-2">
                    {editor.annotation.startLine
                      ? `第 ${editor.annotation.startLine}${editor.annotation.endLine && editor.annotation.endLine !== editor.annotation.startLine ? `–${editor.annotation.endLine}` : ""} 行`
                      : "渲染选区"}
                  </span>
                </p>
                <blockquote className="mb-2 max-h-16 overflow-auto whitespace-pre-wrap border-l-2 border-info-line pl-2 text-ui-caption text-ink-mute">
                  {editor.annotation.quote}
                </blockquote>
                <textarea
                  autoFocus
                  aria-label="批注意见"
                  placeholder="写下意见，或留空仅引用原文"
                  maxLength={COMMENT_LIMIT}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      e.key === "Enter" &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      save();
                    }
                  }}
                  className="min-h-20 w-full resize-y rounded-lg border border-line bg-base p-2"
                />
                <div className="mt-2 flex justify-end gap-2">
                  {annotations.some((a) => a.id === editor.annotation.id) && (
                    <button
                      type="button"
                      className="mr-auto rounded border border-danger-line bg-danger-bg px-2 py-1 text-danger-ink hover:brightness-95"
                      onClick={() => {
                        const store = annotationDrafts?.getState();
                        if (!store) return;
                        const draft = store.drafts[editor.scope];
                        if (
                          store.put(
                            editor.scope,
                            (draft?.annotations ?? []).filter(
                              (a) => a.id !== editor.annotation.id,
                            ),
                          )
                        )
                          setEditor(null);
                      }}
                    >
                      删除
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded px-2 py-1 hover:bg-hover"
                    onClick={() => setEditor(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="rounded bg-ink px-3 py-1 text-[var(--color-base)]"
                    onClick={save}
                  >
                    添加到会话
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="rounded px-2 py-1 hover:bg-hover"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() =>
                  setEditor({
                    ...editor,
                    ...overlayPosition(root.current, editor.x, editor.y, true),
                    open: true,
                  })
                }
              >
                批注
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
