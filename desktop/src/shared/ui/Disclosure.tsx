/**
 * 展开 / 收起：原生 details/summary（键盘、读屏开箱即用），只统一外观——
 * 应用的箭头图标，展开时转 90°，标题行有悬停底色。
 */
import type { ReactNode } from "react";
import { ChevronRightIcon } from "./icons.tsx";
import { focusVisibleRing } from "./controls.tsx";

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  onOpenChange,
  layout = "inline",
  className = "",
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly layout?: "inline" | "row";
  readonly className?: string;
}) {
  return (
    <details
      className={`[&[open]>summary>.disclosure-chevron]:rotate-90 ${className}`}
      open={defaultOpen || undefined}
      onToggle={
        onOpenChange &&
        ((event) => {
          if (event.target === event.currentTarget)
            onOpenChange(event.currentTarget.open);
        })
      }
    >
      <summary
        className={`${layout === "row" ? "flex w-full gap-2 py-2" : "inline-flex gap-1 py-0.5 pr-1.5"} cursor-pointer list-none items-center rounded-control text-ui-sm select-none hover:bg-surface-hover hover:text-ink [&::-webkit-details-marker]:hidden ${focusVisibleRing}`}
      >
        <ChevronRightIcon
          aria-hidden={true}
          className="disclosure-chevron ui-icon-14 shrink-0 transition-transform motion-reduce:transition-none"
        />
        {summary}
      </summary>
      {layout === "row" ? (
        children
      ) : (
        <div className="mt-1 pl-[18px]">{children}</div>
      )}
    </details>
  );
}
