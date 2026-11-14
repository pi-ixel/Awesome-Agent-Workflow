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
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
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
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", update);
    };
  }, [scroll, signature]);

  const last = items.length - 1;
  const explicit = items.some((item) => item.current !== undefined);
  return (
    <nav
      ref={viewport}
      aria-label={label}
      style={scroll ? FADE[fade] : undefined}
      className={`min-w-0 text-ui-sm text-ink-subtle ${scroll ? "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "overflow-hidden"} ${className}`}
    >
      <ol className={`m-0 flex list-none items-center gap-0.5 p-0 ${scroll ? "min-w-max" : "min-w-0"}`}>
        {items.map((item, index) => {
          const current = explicit ? item.current === true : index === last;
          const content = <>{item.icon}<span className="truncate">{item.label}</span></>;
          const base = `inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 ${scroll ? "shrink-0" : current ? "shrink" : "max-w-[40%] shrink-[2]"}`;
          return (
            <li key={item.key ?? index} className={`contents`}>
              {current ? (
                <span aria-current="page" data-hint={item.hint} className={`${base} font-medium text-ink`}>{content}</span>
              ) : item.onSelect ? (
                <button
                  type="button"
                  disabled={item.disabled}
                  data-hint={item.hint}
                  onClick={item.onSelect}
                  className={`${base} cursor-pointer transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink-subtle ${focusVisibleRing}`}
                >
                  {content}
                </button>
              ) : (
                <span data-hint={item.hint} className={base}>{content}</span>
              )}
              {index !== last && <ChevronRightIcon aria-hidden={true} className="size-3.5 shrink-0 text-ink-subtlest" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
