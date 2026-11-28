import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COMMENT_LIMIT } from "../annotations/types.ts";
import { ActionButton, DangerButton } from "./controls.tsx";
import { HintSurface } from "./controls/HintSurface.tsx";
import { settingsTextareaClass } from "./inputStyles.ts";

export interface AnnotationAnchor {
  readonly x: number;
  readonly top?: number;
  readonly bottom: number;
}

export function annotationSelectionAnchor(range: Range): AnnotationAnchor {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  const first = rects[0] ?? range.getBoundingClientRect();
  let { left, right, bottom } = first;
  for (const rect of rects) {
    if (Math.abs(rect.top - first.top) > 1) break;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { x: (left + right) / 2, top: first.top, bottom };
}

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
  const { x, top: anchorTop, bottom: anchorBottom } = anchor;
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const position = () => {
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
    position();
    window.addEventListener("resize", position);
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(position)
        : undefined;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [anchorBottom, anchorTop, container, isOpen, x]);
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
