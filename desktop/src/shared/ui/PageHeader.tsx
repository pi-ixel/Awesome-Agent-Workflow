/**
 * 页面 / 分节标题行：左边「标题（+ 可选条数）」与一句说明，右边整块操作。
 *
 * 从前各处各写一遍，字号和间距都不一致（`text-3xl`、`text-lg`、`text-ui-lg`、
 * `text-sm` 都有），同一个应用里「标题」长得好几种样子。这里收成两份刻度：
 *
 * - `page`：面板里的一页（诊断、归档、工作流库）—— 标题 `text-ui-lg`；
 * - `section`：页面内的一块（如诊断里的「ACP 连接」）—— 标题 `text-ui-base`。
 *
 * 字号都用应用的字号档，跟随设置里的界面字号；不要在调用处再叠字号。
 * 整页操作放 `actions`，不要塞进标题文字里。
 */
import type { ReactNode } from "react";

export function PageHeader({
  title,
  count,
  leading,
  description,
  actions,
  size = "page",
  bordered = false,
  className = "",
}: {
  readonly title: ReactNode;
  /** 条数（运行数、连接数…）：跟在标题后面，弱化处理。 */
  readonly count?: ReactNode;
  readonly leading?: ReactNode;
  /** 标题下的一句说明。 */
  readonly description?: ReactNode;
  /** 右侧操作：整页 / 整块的操作放这里。 */
  readonly actions?: ReactNode;
  readonly size?: "page" | "section";
  readonly bordered?: boolean;
  readonly className?: string;
}) {
  const titleClass =
    size === "page"
      ? "text-ui-lg font-semibold text-ink"
      : "text-ui-base font-semibold text-ink";
  const Heading = size === "page" ? "h1" : "h2";
  return (
    <header
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${bordered ? "border-b border-line px-6 py-4" : ""} ${className}`}
    >
      <div className="flex min-w-0 flex-[1_1_12rem] items-center gap-3">
        {leading && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0">
          <div
            className={`flex min-w-0 items-baseline gap-x-2 ${bordered ? "flex-wrap" : ""}`}
          >
            <Heading
              className={`min-w-0 [overflow-wrap:anywhere] ${titleClass}`}
            >
              {title}
            </Heading>
            {count !== undefined && (
              <span
                className={`text-ui-sm text-ink-mute tabular-nums ${bordered ? "min-w-0" : "shrink-0"}`}
              >
                {count}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-1 text-ui-sm text-ink-mute [overflow-wrap:anywhere]">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
