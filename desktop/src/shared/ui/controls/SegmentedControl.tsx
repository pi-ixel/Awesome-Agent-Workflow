import { useLayoutEffect, useRef, useState } from "react";
import { focusVisibleRing } from "../controls.tsx";

interface IndicatorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function SegmentedControl<T extends string | number>({
  groupLabel,
  value,
  options,
  onChange,
  warnValue,
  tabs = false,
  appearance = "default",
}: {
  readonly groupLabel: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    /** 页签右上角的提醒点：这个页签里有事要你处理（切走时不丢提醒）。 */
    readonly dot?: boolean;
  }[];
  readonly onChange: (next: T) => void;
  readonly warnValue?: T;
  readonly tabs?: boolean;
  readonly appearance?: "default" | "quiet";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prevRectRef = useRef<IndicatorRect | null>(null);
  const [sliding, setSliding] = useState<{
    readonly rect: IndicatorRect;
    readonly animate: boolean;
  } | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const isWarnSelected = selectedIndex >= 0 && value === warnValue;

  useLayoutEffect(() => {
    const activeButton =
      selectedIndex >= 0 ? buttonRefs.current[selectedIndex] : null;
    if (!activeButton) return;
    const width = activeButton.offsetWidth;
    const height = activeButton.offsetHeight;
    if (width <= 0 || height <= 0) return;

    const next: IndicatorRect = {
      left: activeButton.offsetLeft,
      top: activeButton.offsetTop,
      width,
      height,
    };
    const prev = prevRectRef.current;
    prevRectRef.current = next;

    // 仅在从一个已测量位置切换到另一个位置时播放 200ms 滑动动画，
    // 静态状态下由选中按钮自身承载完整视觉样式。
    if (
      !prev ||
      (prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height)
    ) {
      return;
    }

    let rafId = 0;
    let timerId = 0;
    rafId = window.requestAnimationFrame(() => {
      setSliding({ rect: prev, animate: false });
      rafId = window.requestAnimationFrame(() => {
        setSliding({ rect: next, animate: true });
        timerId = window.setTimeout(() => {
          setSliding(null);
        }, 210);
      });
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [selectedIndex]);

  return (
    <div
      ref={containerRef}
      role={tabs ? "tablist" : "group"}
      aria-label={groupLabel}
      className={`relative inline-flex max-w-full flex-wrap gap-0.5 rounded-2xl p-0.5 ${
        appearance === "quiet"
          ? "bg-transparent"
          : "bg-base ring-1 ring-inset ring-line"
      }`}
    >
      {sliding && (
        <span
          aria-hidden={true}
          style={{
            width: sliding.rect.width,
            height: sliding.rect.height,
            transform: `translate3d(${sliding.rect.left}px, ${sliding.rect.top}px, 0)`,
          }}
          className={`pointer-events-none absolute top-0 left-0 ${
            appearance === "quiet" ? "rounded-md" : "rounded-full"
          } border ${
            sliding.animate
              ? "transition-[transform,width,height,background-color,border-color] duration-200 ease-out motion-reduce:transition-none"
              : ""
          } ${
            isWarnSelected
              ? "border-warn-line bg-warn-bg/70"
              : appearance === "quiet"
                ? "border-transparent bg-raised"
                : "border-line-strong bg-surface"
          }`}
        />
      )}
      {options.map((option, index) => {
        const selected = option.value === value;
        const showStaticSurface = selected && !sliding;
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-pressed={tabs ? undefined : selected}
            tabIndex={tabs && !selected ? -1 : undefined}
            onClick={() => onChange(option.value)}
            onKeyDown={
              tabs
                ? (event) => {
                    const last = options.length - 1;
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % options.length
                        : event.key === "ArrowLeft"
                          ? (index + last) % options.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? last
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    const choice = options[next];
                    if (!choice) return;
                    buttonRefs.current[next]?.focus();
                    onChange(choice.value);
                  }
                : undefined
            }
            className={`relative z-10 inline-flex min-h-6 shrink-0 items-center ${
              appearance === "quiet" ? "rounded-md" : "rounded-full"
            } border px-3 text-ui-caption leading-none transition-colors ${focusVisibleRing} ${
              selected && option.value === warnValue
                ? showStaticSurface
                  ? "border-warn-line bg-warn-bg/70 font-medium text-warn-ink"
                  : "border-transparent bg-transparent font-medium text-warn-ink"
                : selected
                  ? showStaticSurface
                    ? appearance === "quiet"
                      ? "border-transparent bg-raised font-medium text-ink"
                      : "border-line-strong bg-surface font-medium text-ink"
                    : "border-transparent bg-transparent font-medium text-ink"
                  : "border-transparent bg-transparent text-ink-mute hover:text-ink"
            }`}
          >
            {option.label}
            {option.dot && (
              <span
                aria-hidden={true}
                data-dot=""
                className="ml-1 inline-block ui-icon-6 shrink-0 rounded-full bg-warn-ink"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
