/**
 * 面包屑：我在哪、点前面的层级回去。最后一项是当前位置。
 *
 * - 默认（truncate）：放不下时各段截断，当前项优先保留；
 * - scroll：路径很长（文件路径）时横向滚动，隐藏滚动条，两端渐隐提示
 *   还有内容；内容变化后先滚到最右，让人先看到文件名。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ChevronRightIcon } from "./icons.tsx";
import { focusVisibleRing } from "./controls.tsx";

export interface BreadcrumbItem {
  readonly key?: string;
  readonly label: ReactNode;
  /** 点了去哪；没有时只显示文字。 */
  readonly onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** 当前位置。都不写时最后一项是当前位置；写了以写的为准（比如最后一项也要能点）。 */
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly icon?: ReactNode;
}

type Fade = "none" | "left" | "right" | "both";

const FADE: Record<Fade, CSSProperties> = {
  none: {},
  left: { WebkitMaskImage: "linear-gradient(to right, transparent 0, black 16px, black 100%)", maskImage: "linear-gradient(to right, transparent 0, black 16px, black 100%)" },
  right: { WebkitMaskImage: "linear-gradient(to right, black 0, black calc(100% - 16px), transparent 100%)", maskImage: "linear-gradient(to right, black 0, black calc(100% - 16px), transparent 100%)" },
  both: { WebkitMaskImage: "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)", maskImage: "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)" },
};

function revealSegment(viewport: HTMLElement, segment: HTMLElement) {
  const frame = viewport.getBoundingClientRect();
  const target = segment.getBoundingClientRect();
  const inset = Math.max(0, Math.min(16, (frame.width - target.width) / 2));
  const left = target.left - frame.left - inset;
  const right = target.right - frame.right + inset;
  if (left < 0) viewport.scrollLeft += left;
  else if (right > 0) viewport.scrollLeft += right;
}

export function Breadcrumb({
  items,
  label = "位置",
  scroll = false,
  className = "",
}: {
  readonly items: readonly BreadcrumbItem[];
  readonly label?: string;
  readonly scroll?: boolean;
  /** 尺寸、内边距等外层样式（默认 text-ui-sm）。 */
  readonly className?: string;
}) {
  const viewport = useRef<HTMLElement | null>(null);
  const [fade, setFade] = useState<Fade>("none");
  const signature = items.map((item, index) => item.key ?? (typeof item.label === "string" ? item.label : String(index))).join("\u0000");

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!scroll || !element) return;
    let followEnd = true;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      followEnd = element.scrollLeft >= max - 1;
      if (max <= 1) return setFade("none");
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft < max - 1;
      setFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
    };
    // 内容变化后先滚到最右（只在这时，用户之后的手动滚动不回弹）。
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      update();
    });
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          const focused = element.ownerDocument.activeElement;
          if (focused instanceof HTMLButtonElement && element.contains(focused)) {
            revealSegment(element, focused);
          } else if (followEnd) {
            element.scrollLeft = element.scrollWidth - element.clientWidth;
          }
          update();
        });
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scroll, signature]);

  const last = items.length - 1;
  const explicit = items.some((item) => item.current !== undefined);
  return (
    <nav
      ref={viewport}
      aria-label={label}
      onFocusCapture={(event) => {
        if (scroll && event.target instanceof HTMLButtonElement && event.target.matches(":focus-visible")) {
          revealSegment(event.currentTarget, event.target);
        }
      }}
      style={scroll ? FADE[fade] : undefined}
      className={`min-w-0 text-ui-sm text-ink-subtle ${scroll ? "@container scrollbar-hide overflow-x-auto" : "overflow-hidden"} ${className}`}
    >
      <ol className={`m-0 flex list-none items-center gap-0.5 p-0 ${scroll ? "min-w-max" : "min-w-0"}`}>
        {items.map((item, index) => {
          const current = explicit ? item.current === true : index === last;
          const content = <>{item.icon}<span className="truncate">{item.label}</span></>;
          const base = `inline-flex min-w-0 items-center gap-1 rounded-control px-1 py-0.5 ${scroll ? "max-w-[100cqw] shrink-0" : current ? "shrink" : "max-w-[40%] shrink-[2]"}`;
          const hint = item.hint ?? (scroll && typeof item.label === "string" ? item.label : undefined);
          return (
            <li key={item.key ?? index} className={`contents`}>
              {current ? (
                <span aria-current="page" data-hint={hint} className={`${base} font-medium text-ink`}>{content}</span>
              ) : item.onSelect ? (
                <button
                  type="button"
                  disabled={item.disabled}
                  data-hint={hint}
                  onClick={item.onSelect}
                  className={`${base} cursor-pointer transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink-subtle focus-visible:ring-inset ${focusVisibleRing}`}
                >
                  {content}
                </button>
              ) : (
                <span data-hint={hint} className={base}>{content}</span>
              )}
              {index !== last && <ChevronRightIcon aria-hidden={true} className="ui-icon-14 shrink-0 text-ink-subtlest" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
