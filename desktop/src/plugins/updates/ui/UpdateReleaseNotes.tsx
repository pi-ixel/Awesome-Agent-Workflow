import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
      <div className="max-h-72 overflow-y-auto overscroll-contain border-t border-line pt-3 [overflow-wrap:anywhere] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
        <MarkdownView
          text={release.notes.trim() || "新版本已准备就绪，暂无详细更新说明。"}
          onOpenExternal={openExternal}
        />
      </div>
    </>
  );
}

/** Interactive hover card: portalled outside the sidebar's clipping container. */
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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const id = useId();
  const clearTimer = () => clearTimeout(timer.current);
  const close = () => {
    clearTimer();
    setPosition(null);
  };
  const show = () => {
    clearTimer();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(16, Math.min(rect.left, window.innerWidth - 400)),
        top: rect.bottom + 4,
      });
  };
  const scheduleClose = () => {
    clearTimer();
    timer.current = setTimeout(() => setPosition(null), 180);
  };
  const blur = (event: React.FocusEvent) => {
    const target = event.relatedTarget as Node | null;
    if (!anchor.current?.contains(target) && !card.current?.contains(target))
      scheduleClose();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const dismiss = () => {
      clearTimeout(timer.current);
      setPosition(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
      if (!card.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [position]);
  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={() => {
        clearTimer();
        timer.current = setTimeout(show, 250);
      }}
      onMouseLeave={scheduleClose}
      onFocus={show}
      onBlur={blur}
      onClick={close}
    >
      {children}
      {position &&
        createPortal(
          <div
            ref={card}
            role="region"
            aria-labelledby={id}
            tabIndex={0}
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            onFocus={clearTimer}
            onBlur={blur}
            onClick={(event) => event.stopPropagation()}
            className="fixed z-[60] flex w-96 max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-xl border border-line-strong bg-surface p-4 text-ink shadow-elev-3"
            style={{
              ...position,
              maxHeight: `calc(100vh - ${position.top + 16}px)`,
            }}
          >
            <h2 id={id} className="mb-1 text-sm font-medium">
              v{release.version} 更新日志
            </h2>
            <ReleaseNotes release={release} openExternal={openExternal} />
            <button
              type="button"
              className="mt-3 self-start text-xs text-ink-soft underline hover:text-ink"
              onClick={() => {
                void openExternal(
                  "https://github.com/pi-ixel/Awesome-Agent-Workflow/releases",
                ).catch(() => {});
              }}
            >
              查看全部更新日志
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
