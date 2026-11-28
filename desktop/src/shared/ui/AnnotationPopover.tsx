import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COMMENT_LIMIT } from "../annotations/types.ts";
import { visibleSelectionAnchor } from "../annotations/selectionGeometry.ts";
import { ActionButton, DangerButton } from "./controls.tsx";
import { HintSurface } from "./controls/HintSurface.tsx";
import { settingsTextareaClass } from "./inputStyles.ts";

export type AnnotationAnchor =
  | { readonly range: Range }
  | {
      readonly x: number;
      readonly bottom: number;
      readonly top?: undefined;
    };

export function AnnotationPopover({
  root,
  anchor,
  file,
  location,
  quote,
  comment,
  error,
  isSaving,
  onOpen,
  onComment,
  onSave,
  onRemove,
  onClose,
}: {
  readonly root: RefObject<HTMLElement | null>;
  readonly anchor: AnnotationAnchor;
  readonly file: string;
  readonly location: string;
  readonly quote: string;
  readonly comment: string;
  readonly error?: string | null;
  readonly isSaving?: boolean;
  readonly onOpen?: () => void;
  readonly onComment: (comment: string) => void;
  readonly onSave: () => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}) {
  const isOpen = !onOpen;
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose]);
  // 放大审阅中的编辑器要留在父弹窗的焦点范围内。
  const container = root.current?.closest(".modal-panel") ?? document.body;
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let frame = 0;
    const position = () => {
      const resolved =
        "range" in anchor ? visibleSelectionAnchor(anchor.range) : anchor;
      if (!resolved) {
        if (!isOpen) element.style.visibility = "hidden";
        return;
      }
      element.style.visibility = "";
      const { x, top: anchorTop, bottom: anchorBottom } = resolved;
      const bounds =
        container === document.body ? null : container.getBoundingClientRect();
      const left = Math.max(0, bounds?.left ?? 0) + 8;
      const top = Math.max(0, bounds?.top ?? 0) + 8;
      const right =
        Math.min(window.innerWidth, bounds?.right ?? window.innerWidth) - 8;
      const bottom =
        Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - 8;
      const below = anchorBottom + 6;
      const above = (anchorTop ?? anchorBottom) - 6 - element.offsetHeight;
      const prefersAbove = anchorTop !== undefined;
      const placeAbove = prefersAbove
        ? above >= top
        : below + element.offsetHeight > bottom;
      const alignedLeft = prefersAbove ? x - element.offsetWidth / 2 : x;
      element.style.left = `${Math.max(left, Math.min(alignedLeft, right - element.offsetWidth))}px`;
      element.style.top = `${Math.max(top, Math.min(placeAbove ? above : below, bottom - element.offsetHeight))}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    position();
    window.addEventListener("resize", schedule);
    if ("range" in anchor) document.addEventListener("scroll", schedule, true);
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : undefined;
    observer?.observe(element);
    if (root.current) observer?.observe(root.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [anchor, container, isOpen, root]);
  return createPortal(
    <HintSurface
      ref={surface}
      open
      role={isOpen ? "dialog" : "group"}
      aria-label={isOpen ? "文档批注" : "选区操作"}
      data-file-find-ignore
      data-annotation-overlay
      className={`fixed z-[100] max-w-[calc(100vw-16px)] ${isOpen ? "p-2.5 text-ui-base" : "annotation-rainbow-border p-0.5 text-ui-caption"}`}
      style={{ width: isOpen ? 304 : undefined }}
    >
      {isOpen ? (
        <>
          <p className="mb-2 truncate text-ui-caption text-ink-mute">
            {file}
            <span className="ml-2">{location}</span>
          </p>
          <blockquote className="mb-2 max-h-16 overflow-auto whitespace-pre-wrap border-l-2 border-info-line pl-2 text-ui-caption text-ink-mute">
            {quote}
          </blockquote>
          <textarea
            autoFocus
            aria-label="批注意见"
            placeholder="写下意见，或留空仅引用原文"
            maxLength={COMMENT_LIMIT}
            value={comment}
            onChange={(event) => onComment(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                !isSaving
              ) {
                event.preventDefault();
                onSave();
              }
            }}
            className={`${settingsTextareaClass} min-h-20`}
          />
          {error && (
            <p role="alert" className="mt-2 text-ui-caption text-danger-ink">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            {onRemove && (
              <DangerButton
                type="button"
                className="mr-auto px-2 py-1"
                disabled={isSaving}
                onClick={onRemove}
              >
                删除
              </DangerButton>
            )}
            <ActionButton
              tone="ghost"
              size="compact"
              type="button"
              onClick={onClose}
            >
              取消
            </ActionButton>
            <ActionButton
              tone="primary"
              size="compact"
              type="button"
              disabled={isSaving}
              onClick={onSave}
            >
              添加到会话
            </ActionButton>
          </div>
        </>
      ) : (
        <ActionButton
          tone="ghost"
          size="compact"
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onOpen}
        >
          批注
        </ActionButton>
      )}
    </HintSurface>,
    container,
  );
}
