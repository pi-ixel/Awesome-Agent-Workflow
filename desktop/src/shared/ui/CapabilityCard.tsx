import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { NavigationRow } from "./NavigationRow.tsx";

export function CapabilityCard({
  name,
  description,
  icon,
  actions,
  status,
  onDetail,
}: {
  readonly name: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly actions: ReactNode;
  readonly status?: string;
  readonly onDetail: (button: HTMLButtonElement) => void;
}) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const clip = viewport.current;
    const content = text.current;
    if (!clip || !content) return;
    const measure = () =>
      setOverflow(Math.max(0, content.offsetWidth - clip.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    observer.observe(content);
    return () => observer.disconnect();
  }, [description]);
  const animation = {
    "--description-offset": `-${overflow}px`,
    "--description-duration": `${Math.max(1200, overflow * 28)}ms`,
  } as CSSProperties;
  return (
    <article
      aria-label={name}
      className="group/capability-card flex min-h-16 min-w-0 items-stretch gap-1 rounded-xl border border-line bg-surface pr-2 transition-colors hover:border-line-strong focus-within:border-line-strong"
    >
      <NavigationRow
        layout="compound"
        className="group/card-main items-center gap-2 px-2.5 py-2 leading-tight"
        aria-label={`查看 ${name} 详情`}
        onClick={(event) => onDetail(event.currentTarget)}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-selected text-ink-mute">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-ui-base font-semibold"
            data-hint={name}
          >
            {name}
          </span>
          {description && (
            <span
              ref={viewport}
              className="mt-0.5 block overflow-hidden whitespace-nowrap text-ui-caption text-ink-mute"
            >
              <span
                ref={text}
                style={overflow > 0 ? animation : undefined}
                className={
                  overflow > 0
                    ? "inline-block transition-transform duration-0 ease-linear motion-safe:group-hover/capability-card:translate-x-(--description-offset) motion-safe:group-hover/capability-card:duration-(--description-duration) motion-safe:group-focus-visible/card-main:translate-x-(--description-offset) motion-safe:group-focus-visible/card-main:duration-(--description-duration)"
                    : "inline-block"
                }
              >
                {description}
              </span>
            </span>
          )}
          {status && (
            <span
              className="mt-0.5 block truncate text-ui-xs text-warn-ink"
              data-hint={status}
            >
              {status}
            </span>
          )}
        </span>
      </NavigationRow>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </article>
  );
}
