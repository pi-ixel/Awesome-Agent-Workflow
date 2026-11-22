/**
 * 空状态：还没有内容时说清楚「这里会有什么、怎么得到第一个」。
 * 图标（可选）→ 一句标题 → 一句说明 → 一个下一步操作。
 */
import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
  density = "standard",
  role = "status",
  className = "",
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly density?: "standard" | "compact";
  readonly role?: "status" | "alert";
  readonly className?: string;
}) {
  return (
    <div
      role={role}
      className={`flex min-w-0 flex-col items-center gap-1.5 px-3 py-6 text-center ${density === "compact" ? "min-h-32 justify-center" : ""} ${className}`}
    >
      {icon && (
        <span
          aria-hidden={true}
          className={`mb-1 text-ink-faint ${density === "compact" ? "[&_svg]:ui-icon-16" : "[&_svg]:ui-icon-24"}`}
        >
          {icon}
        </span>
      )}
      <span className="text-ui-sm font-medium text-ink">{title}</span>
      {description && (
        <span className="w-full max-w-[34ch] [overflow-wrap:anywhere] text-ui-sm text-ink-mute">
          {description}
        </span>
      )}
      {action && (
        <div className="mt-1.5 flex flex-wrap justify-center gap-2">
          {action}
        </div>
      )}
    </div>
  );
}
