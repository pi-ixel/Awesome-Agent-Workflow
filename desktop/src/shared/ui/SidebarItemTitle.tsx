import type { ReactNode } from "react";

/** 侧栏条目标题统一跟随界面字号，插件通过父容器控制布局。 */
export function SidebarItemTitle({
  children,
  hint,
}: {
  readonly children: ReactNode;
  readonly hint?: string;
}) {
  return (
    <span
      className="min-w-0 flex-1 truncate font-sans text-ui-base font-normal text-ink"
      data-hint={hint}
    >
      {children}
    </span>
  );
}
