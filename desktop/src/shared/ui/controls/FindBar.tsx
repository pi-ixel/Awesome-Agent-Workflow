import { embeddedFieldClass } from "../inputStyles.ts";
import { IconButton } from "../IconButton.tsx";
import { useEffect, type ReactNode, type RefObject } from "react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "../icons.tsx";
import { focusVisibleRing } from "../controls.tsx";
import { HintSurface } from "./HintSurface.tsx";

export const findFieldClass = `${embeddedFieldClass} flex-1 font-medium`;
export const findActionClass = `flex shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${focusVisibleRing}`;

export function FindBar({
  label,
  placeholder,
  query,
  matchCount,
  activeIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  inputRef,
  enterNavigates = false,
  actions,
  children,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly onQueryChange: (query: string) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onClose: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly enterNavigates?: boolean;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) {
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [inputRef]);

  return (
    <HintSurface
      open
      role="dialog"
      aria-label={label}
      className="@container/find absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden"
    >
      <div className="flex h-9 items-center gap-1.5 px-2 @max-[239px]/find:h-auto @max-[239px]/find:flex-wrap @max-[239px]/find:justify-end @max-[239px]/find:py-1">
        <div className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 @max-[239px]/find:basis-full">
          <SearchIcon className="ui-icon-14 shrink-0 text-ink" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (
                event.key === "ArrowUp" ||
                event.key === "ArrowDown" ||
                (enterNavigates && event.key === "Enter")
              ) {
                event.preventDefault();
                if (matchCount === 0) return;
                if (
                  event.key === "ArrowUp" ||
                  (event.key === "Enter" && event.shiftKey)
                )
                  onPrevious();
                else onNext();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className={findFieldClass}
          />
        </div>
        <div
          aria-live="polite"
          className="min-w-9 shrink-0 text-center text-xs font-medium text-ink-mute tabular-nums"
        >
          {matchCount > 0 ? activeIndex + 1 : 0}/{matchCount}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1.5">
          <IconButton
            iconSize="compact"
            type="button"
            aria-label="上一个结果"
            data-hint="上一个结果"
            disabled={!matchCount}
            onClick={onPrevious}
            className={findActionClass}
          >
            <ArrowUpIcon className="ui-icon-14" />
          </IconButton>
          <IconButton
            iconSize="compact"
            type="button"
            aria-label="下一个结果"
            data-hint="下一个结果"
            disabled={!matchCount}
            onClick={onNext}
            className={findActionClass}
          >
            <ArrowDownIcon className="ui-icon-14" />
          </IconButton>
        </div>
        {actions}
        <div className="ml-0.5 flex shrink-0 border-l border-line pl-1.5">
          <IconButton
            iconSize="compact"
            type="button"
            aria-label="关闭查找"
            data-hint="关闭查找"
            onClick={onClose}
            className={findActionClass}
          >
            <XIcon className="ui-icon-14" />
          </IconButton>
        </div>
      </div>
      {children}
    </HintSurface>
  );
}
