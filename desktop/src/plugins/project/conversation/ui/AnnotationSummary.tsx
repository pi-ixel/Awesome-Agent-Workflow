import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { AnnotationCards } from "./AnnotationCards.tsx";
import { XIcon } from "../../../../shared/ui/icons.tsx";

/** Hover entry and portal share a delayed exit, so crossing the gap does not close the editor. */
export function AnnotationSummary({
  onClear,
  className = "px-3 pt-3",
  ...props
}: ComponentProps<typeof AnnotationCards> & {
  onClear?: () => boolean;
  className?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const entry = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    above: boolean;
  } | null>(null);
  const count = props.annotations.length;
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const open = () => {
    cancelClose();
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 428)),
      top: rect.top >= 200 ? rect.top - 8 : rect.bottom + 8,
      above: rect.top >= 200,
    });
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      const active = document.activeElement;
      if (
        active &&
        panel.current?.contains(active) &&
        active.matches("textarea,input")
      )
        return;
      setPosition(null);
    }, 220);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!position || !count) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !entry.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      ) {
        cancelClose();
        setPosition(null);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelClose();
        setPosition(null);
        button.current?.focus();
      }
    };
    const close = () => {
      cancelClose();
      setPosition(null);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
    };
  }, [position, count]);
  if (!count) {
    if (position) setPosition(null);
    return null;
  }
  return (
    <div className={className}>
      <div
        ref={entry}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        className="annotation-rainbow-border group relative inline-flex items-center rounded-full bg-ink/5 text-ui-caption text-ink hover:bg-ink/10"
      >
        <button
          ref={button}
          type="button"
          aria-expanded={position !== null}
          aria-haspopup="dialog"
          className="inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5"
          onClick={open}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5 text-ink-mute"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          >
            <path d="M3 2.5h10v8H6L3 13v-10Z" />
            <path d="M5 5h6M5 7.5h4" />
          </svg>
          {count} 条评论
        </button>
        {onClear && (
          <button
            type="button"
            aria-label="删除全部评论"
            title="删除全部评论"
            className="mr-1 flex size-5 items-center justify-center rounded-full text-ink-mute opacity-0 transition-opacity hover:bg-ink/10 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              if (onClear()) {
                cancelClose();
                setPosition(null);
              }
            }}
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
      {position &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="文档评论"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            className="fixed z-[100] w-[420px] max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-line bg-surface text-ink"
            style={{
              left: position.left,
              top: position.top,
              transform: position.above ? "translateY(-100%)" : undefined,
              maxHeight: Math.max(
                80,
                Math.min(
                  360,
                  position.above
                    ? position.top - 8
                    : window.innerHeight - position.top - 8,
                ),
              ),
            }}
          >
            <AnnotationCards {...props} />
          </div>,
          document.body,
        )}
    </div>
  );
}
