import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { HintSurface } from "../../../shared/ui/controls/HintSurface.tsx";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { UpdateManifest } from "../../host/types.ts";
import type { UpdatesService } from "../service.ts";
import { MarkdownView } from "../../../shared/ui/MarkdownView.tsx";

export function ReleaseNotes({
  release,
  openExternal,
}: {
  readonly release: UpdateManifest;
  readonly openExternal: UpdatesService["openExternal"];
}) {
  const date = release.published_at;
  return (
    <>
      {date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? (
        <time dateTime={date} className="mb-2 block text-xs text-ink-mute">
          {date.replace(/^(\d+)-(\d+)-(\d+)$/, "$1年$2月$3日")}
        </time>
      ) : null}
      <div className="max-h-72 overflow-y-auto overscroll-contain border-t border-line pt-3 [overflow-wrap:anywhere] [&_h1]:text-ui-lg [&_h2]:text-sm [&_h3]:text-sm">
        <MarkdownView
          text={release.notes.trim() || "新版本已准备就绪，暂无详细更新说明。"}
          onOpenExternal={openExternal}
        />
      </div>
    </>
  );
}

/** 更新说明挂载在侧栏之外，避免被侧栏裁切。 */
export function UpdateReleaseNotes({
  release,
  openExternal,
  children,
}: {
  readonly release: UpdateManifest;
  readonly openExternal: UpdatesService["openExternal"];
  readonly children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const returningFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isOpen, setOpen] = useState(false);
  const id = useId();
  const clearTimer = () => clearTimeout(timer.current);
  const close = () => {
    clearTimer();
    setOpen(false);
  };
  const show = () => {
    clearTimer();
    setOpen(true);
  };
  const scheduleClose = () => {
    clearTimer();
    timer.current = setTimeout(() => {
      if (!card.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const surface = card.current;
    if (!isOpen || !trigger || !surface) return;
    let frame = 0;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const margin = 16;
      const gap = 4;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const aboveTrigger = below < surface.scrollHeight && above > below;
      surface.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - surface.offsetWidth - margin))}px`;
      surface.style.top = `${aboveTrigger ? rect.top - gap : rect.bottom + gap}px`;
      surface.style.transform = aboveTrigger ? "translateY(-100%)" : "";
      surface.style.maxHeight = `${Math.max(0, aboveTrigger ? above : below)}px`;
    };
    place();
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(trigger);
    observer?.observe(surface);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [isOpen]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!isOpen) return;
    const dismiss = () => {
      clearTimeout(timer.current);
      setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        !anchor.current?.contains(event.target as Node) &&
        !card.current?.contains(event.target as Node)
      )
        dismiss();
    };
    const scroll = (event: Event) => {
      if (
        !card.current?.contains(event.target as Node) &&
        !card.current?.contains(document.activeElement)
      )
        dismiss();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [isOpen]);
  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={() => {
        clearTimer();
        timer.current = setTimeout(show, 250);
      }}
      onMouseLeave={scheduleClose}
      onFocus={(event) => {
        if (
          !returningFocus.current &&
          event.currentTarget.contains(event.target)
        )
          show();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          next &&
          !anchor.current?.contains(next) &&
          !card.current?.contains(next)
        )
          scheduleClose();
      }}
      onKeyDown={(event) => {
        if (!isOpen || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (card.current?.contains(document.activeElement)) {
            returningFocus.current = true;
            anchor.current
              ?.querySelector("button")
              ?.focus({ preventScroll: true });
            returningFocus.current = false;
          }
          close();
        } else if (
          (event.key === "ArrowDown" ||
            (event.key === "Tab" && !event.shiftKey)) &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          card.current?.focus({ preventScroll: true });
        }
      }}
      onClick={close}
    >
      {children}
      {createPortal(
        <HintSurface
          open={isOpen}
          ref={card}
          role="region"
          aria-labelledby={id}
          tabIndex={0}
          onMouseEnter={clearTimer}
          onMouseLeave={scheduleClose}
          onFocus={clearTimer}
          onClick={(event) => event.stopPropagation()}
          className="fixed z-[60] flex w-96 max-w-[calc(100vw-32px)] flex-col overflow-y-auto p-4 focus-visible:outline focus-visible:outline-focus-ring"
        >
          <h2 id={id} className="mb-1 text-sm font-medium">
            v{release.version} 更新日志
          </h2>
          <ReleaseNotes release={release} openExternal={openExternal} />
          <TextLink
            type="button"
            className="mt-3 self-start"
            onClick={() => {
              void openExternal(
                "https://github.com/pi-ixel/Awesome-Agent-Workflow/releases",
              ).catch(() => {});
            }}
          >
            查看全部更新日志
          </TextLink>
        </HintSurface>,
        document.body,
      )}
    </span>
  );
}
