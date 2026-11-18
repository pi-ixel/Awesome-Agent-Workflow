import type { ReactNode } from "react";

/** 图标栏和侧栏底部共用留白与行高，避免各插件自行估算垂直位置。 */
export const sidebarFooterInset = "pb-2";

export function SidebarFooterRow({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-sidebar-footer-row=""
      className={`flex min-h-9 items-center ${className}`}
    >
      {children}
    </div>
  );
}
