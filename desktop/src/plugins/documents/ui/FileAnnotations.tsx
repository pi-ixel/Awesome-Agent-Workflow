import {
  AnnotationPopover,
  type AnnotationAnchor,
} from "../../../shared/ui/AnnotationPopover.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import type { MarkdownEditorApi } from "./MarkdownSourceEditor.tsx";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { documentRevision, locateAnnotation } from "../annotations/anchors.ts";
import { QUOTE_LIMIT } from "../config.ts";
import type { DocumentAnnotation } from "../types.ts";
import { useStore } from "zustand";
import type { DocumentsService } from "../service.ts";
import type { ProjectAnnotationEditor } from "../../project/service.ts";
import type { AnnotationDraftTarget } from "../../project/types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { documentTextIndex } from "./documentAnnotationIndex.ts";
import { DocumentAnnotationContext } from "./annotationView.ts";

interface Editor {
  readonly owner: ProjectAnnotationEditor;
  readonly annotation: DocumentAnnotation;
  readonly target: AnnotationDraftTarget;
  readonly anchor: AnnotationAnchor;
  readonly open: boolean;
}

const noSubscription = () => () => {};
const emptyAnnotations: readonly DocumentAnnotation[] = [];

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
  const annotationEditor = useContext(DocumentAnnotationContext);
  const readTarget = () => annotationEditor?.current(project);
  const currentTarget = useSyncExternalStore(
    annotationEditor?.subscribeTarget ?? noSubscription, readTarget, readTarget,
  );
  const readAnnotations = () =>
    currentTarget ? annotationEditor?.read(currentTarget) ?? emptyAnnotations : emptyAnnotations;
  const annotations = useSyncExternalStore(
    annotationEditor?.subscribeDrafts ?? noSubscription, readAnnotations, readAnnotations,
  );
  useEffect(() => {
    if (currentTarget) annotationEditor?.ensure(currentTarget);
  }, [annotationEditor, currentTarget]);
  const items = useMemo(
    () =>
      annotations.filter(
        (a) =>
          !a.diff && pathKey(a.path) === pathKey(path) && a.source === source,
      ),
    [annotations, path, source],
  );
  const request = useStore(documents.annotationNavigation);
  const requestAnnotation =
    request &&
    request.ready &&
    request.target === currentTarget &&
    (!request.draft ||
      annotations.some((a) => a.id === request.annotation.id)) &&
    !request.annotation.diff &&
    pathKey(request.annotation.project) === pathKey(project) &&
    pathKey(request.annotation.path) === pathKey(path) &&
    request.annotation.source === source
      ? request.annotation
      : null;
  const [editorState, setEditor] = useState<Editor | null>(null);
  const editor = editorState?.owner === annotationEditor ? editorState : null;
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useMemo(() => documentRevision(text), [text]);
  const highlightName = `annotation-${instance.replace(/[^a-z0-9]/gi, "")}`;

  useEffect(() => {
    const element = root.current;
    if (!element || !annotationEditor || !currentTarget) return;
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
        owner: annotationEditor,
        target: currentTarget,
        anchor: { range: selected },
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
  }, [root, project, path, source, currentTarget, revision, text, sourceEditor, annotationEditor]);

  useEffect(
    () => {
      if (!editor) return;
      return editor.owner.followPromotion(editor.target, (target) => {
        setEditor((current) =>
          current?.owner === editor.owner && current.target === editor.target
            ? { ...current, target }
            : current,
        );
      });
    },
    [editor],
  );

  useEffect(() => {
    const nonce = request?.nonce;
    if (!requestAnnotation || nonce === undefined) return;
    const timer = setTimeout(() => documents.clearAnnotation(nonce), 3000);
    return () => clearTimeout(timer);
  }, [documents, requestAnnotation, request?.nonce]);

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
      if (!hit || !annotationEditor || !currentTarget) return;
      setComment(hit.annotation.comment);
      setEditor({
        owner: annotationEditor,
        annotation: hit.annotation,
        target: currentTarget,
        anchor: { x: event.clientX, bottom: event.clientY },
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
    currentTarget,
    revision,
    highlightName,
    text,
    sourceEditor,
    reveal,
    source,
    annotationEditor,
  ]);

  function save() {
    if (!editor) return;
    const error = editor.owner.upsert(editor.target, { ...editor.annotation, comment: comment.trim() });
    if (error !== null) {
      setNotice(error);
      return;
    }
    setEditor(null);
    window.getSelection()?.removeAllRanges();
    const stillCurrent = editor.target === editor.owner.current(project);
    setNotice(stillCurrent ? "已添加到会话输入框" : "已保存到原会话草稿");
    if (!stillCurrent) return;
    void editor.owner.showAfterSave(project, editor.target)
      .then((result) => {
        if (result && !result.ok && editor.owner.current(project))
          setNotice(`批注已保存。${result.reason}`);
      })
      .catch(() => {
        if (editor.owner.current(project))
          setNotice("批注已保存，连接失败，请稍后打开该项目的新会话。");
      });
  }
  return (
    <>
      <style>{`::highlight(${highlightName}) { background: color-mix(in srgb, var(--color-annotation-underline) 22%, transparent); text-decoration: underline var(--color-annotation-underline); }`}</style>
      {notice && (
        <div
          role="status"
          className="flex items-center justify-between border-b border-line px-3 py-1 text-ui-caption text-ink-mute"
          data-file-find-ignore
        >
          {notice}
          <IconButton iconSize="compact"
            type="button"
            aria-label="关闭批注提示"
            onClick={() => setNotice("")}
          >
            ×
          </IconButton>
        </div>
      )}
      {editor && (
        <AnnotationPopover
          root={root}
          anchor={editor.anchor}
          file={editor.annotation.path.split(/[\\/]/).at(-1) ?? editor.annotation.path}
          location={editor.annotation.startLine
            ? `第 ${editor.annotation.startLine}${editor.annotation.endLine && editor.annotation.endLine !== editor.annotation.startLine ? `–${editor.annotation.endLine}` : ""} 行`
            : "渲染选区"}
          quote={editor.annotation.quote}
          comment={comment}
          onComment={setComment}
          onClose={() => setEditor(null)}
          onSave={save}
          onRemove={annotations.some((a) => a.id === editor.annotation.id)
            ? () => { if (editor.owner.remove(editor.target, editor.annotation.id)) setEditor(null); }
            : undefined}
          onOpen={!editor.open ? () => setEditor({
            ...editor,
            open: true,
          }) : undefined}
        />
      )}
    </>
  );
}
