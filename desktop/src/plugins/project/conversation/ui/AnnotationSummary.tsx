import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { AnnotationCards } from "./AnnotationCards.tsx";
import { MessageCircleIcon, XIcon } from "../../../../shared/ui/icons.tsx";

/** 入口和浮层共享关闭延时，允许鼠标跨过两者之间的空隙。 */
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
  const focusOnOpen = useRef(false);
  const panelId = useId();
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
  const open = (focus = false) => {
    cancelClose();
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    if (focus) focusOnOpen.current = true;
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
      if (panel.current?.contains(active) || entry.current?.contains(active))
        return;
      setPosition(null);
    }, 220);
  };
  useLayoutEffect(() => {
    if (position && focusOnOpen.current) {
      focusOnOpen.current = false;
      panel.current?.focus({ preventScroll: true });
    }
  }, [position]);
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
    const close = () => {
      cancelClose();
      setPosition(null);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
    };
  }, [position, count]);
  if (!count) {
    if (position) setPosition(null);
    return null;
  }
  return (
    <div
      className={className}
      onKeyDownCapture={(event) => {
        if (!position || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancelClose();
        setPosition(null);
        button.current?.focus({ preventScroll: true });
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          next &&
          !entry.current?.contains(next) &&
          !panel.current?.contains(next)
        )
          scheduleClose();
      }}
    >
      <div
        ref={entry}
        onMouseEnter={() => open()}
        onMouseLeave={scheduleClose}
        className="annotation-rainbow-border group relative inline-flex items-center rounded-pill bg-ink/5 text-ui-caption text-ink hover:bg-ink/10"
      >
        <ActionButton
          tone="ghost"
          ref={button}
          type="button"
          aria-expanded={position !== null}
          aria-controls={position ? panelId : undefined}
          aria-haspopup="dialog"
          className="inline-flex items-center gap-1.5 rounded-pill! py-1 pl-3 pr-1.5"
          onClick={() => open(true)}
        >
          <MessageCircleIcon className="ui-icon-14 text-ink-mute" />
          {count} 条评论
        </ActionButton>
        {onClear && (
          <IconButton
            iconSize="compact"
            type="button"
            aria-label="删除全部评论"
            data-hint="删除全部评论"
            className="mr-1 flex items-center justify-center rounded-pill text-ink-mute opacity-0 transition-opacity hover:bg-ink/10 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              if (onClear()) {
                cancelClose();
                setPosition(null);
              }
            }}
          >
            <XIcon className="ui-icon-12" />
          </IconButton>
        )}
      </div>
      {createPortal(
        <HintSurface
          open={position !== null}
          id={panelId}
          ref={panel}
          role="dialog"
          aria-label="文档评论"
          tabIndex={-1}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onFocus={cancelClose}
          className="fixed z-[100] w-[420px] max-w-[calc(100vw-16px)] overflow-auto focus-visible:keyboard-focus-marker"
          style={
            position
              ? {
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
                }
              : undefined
          }
        >
          <AnnotationCards {...props} />
        </HintSurface>,
        document.body,
      )}
    </div>
  );
}
