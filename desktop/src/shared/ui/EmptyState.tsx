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
  className = "",
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div role="status" className={`flex flex-col items-center gap-1.5 px-3 py-6 text-center ${className}`}>
      {icon && <span aria-hidden={true} className="mb-1 text-ink-faint [&_svg]:size-6">{icon}</span>}
      <span className="text-ui-sm font-medium text-ink">{title}</span>
      {description && <span className="max-w-[34ch] text-ui-sm text-ink-mute">{description}</span>}
      {action && <div className="mt-1.5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
