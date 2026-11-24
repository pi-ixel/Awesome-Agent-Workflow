import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { NavigationRow } from "./NavigationRow.tsx";

export const capabilityGridClass =
  "grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-2.5";

export function CapabilityCard({
  name,
  description,
  icon,
  toggle,
  actions,
  metadata,
  status,
  onDetail,
  detailLabel,
  detailDisabled,
}: {
  readonly name: string;
  readonly description?: string;
  readonly icon: ReactNode;
  readonly toggle: ReactNode;
  readonly actions?: ReactNode;
  readonly metadata?: string;
  readonly status?: string;
  readonly onDetail?: (button: HTMLButtonElement) => void;
  readonly detailLabel?: string;
  readonly detailDisabled?: boolean;
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
  const heading = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-control bg-skill-reference-lilac/10 text-skill-reference-lilac">
        {icon}
      </span>
      <span
        className="min-w-0 truncate text-ui-base font-semibold"
        data-hint={name}
      >
        {name}
      </span>
    </>
  );
  return (
    <article
      aria-label={name}
      className="group/capability-card grid h-full min-w-0 grid-rows-[auto_auto_auto] gap-1.5 rounded-popover border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong focus-within:border-line-strong"
    >
      <div className="flex min-w-0 items-center gap-2">
        {onDetail ? (
          <NavigationRow
            layout="compound"
            className="items-center gap-2"
            aria-label={detailLabel ?? `查看 ${name} 详情`}
            onClick={(event) => onDetail(event.currentTarget)}
            disabled={detailDisabled}
          >
            {heading}
          </NavigationRow>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {heading}
          </div>
        )}
        <div className="flex shrink-0 items-center">{toggle}</div>
      </div>
      <span
        ref={viewport}
        className="block h-[1lh] min-w-0 overflow-hidden whitespace-nowrap text-ui-caption text-ink-mute"
      >
        <span
          ref={text}
          style={overflow > 0 ? animation : undefined}
          className={
            overflow > 0
              ? "inline-block whitespace-nowrap transition-transform duration-0 ease-linear motion-safe:group-hover/capability-card:translate-x-(--description-offset) motion-safe:group-hover/capability-card:duration-(--description-duration) motion-safe:group-has-[button:focus-visible]/capability-card:translate-x-(--description-offset) motion-safe:group-has-[button:focus-visible]/capability-card:duration-(--description-duration)"
              : "inline-block whitespace-nowrap"
          }
        >
          {description}
        </span>
      </span>
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-caption text-ink-mute">
          {metadata && (
            <span className="truncate" data-hint={metadata}>
              {metadata}
            </span>
          )}
          {status && (
            <span
              className="min-w-0 max-w-full shrink-0 truncate text-warn-ink"
              data-hint={status}
            >
              {status}
            </span>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
    </article>
  );
}
