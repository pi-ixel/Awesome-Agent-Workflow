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
  className = "",
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}) {
  return (
    <details className={`group ${className}`} open={defaultOpen || undefined}>
      <summary
        className={`inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pr-1.5 text-ui-sm select-none hover:bg-surface-hover hover:text-ink [&::-webkit-details-marker]:hidden ${focusVisibleRing}`}
      >
        <ChevronRightIcon aria-hidden={true} className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="mt-1 pl-[18px]">{children}</div>
    </details>
  );
}
