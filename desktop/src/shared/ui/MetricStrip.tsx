import type { ReactNode } from "react";

interface Metric {
  label: string;
  value: ReactNode;
  title?: string;
}

export function MetricStrip({
  label,
  metrics,
  embedded = false,
  children,
}: {
  label?: string;
  metrics: readonly Metric[];
  embedded?: boolean;
  children?: ReactNode;
}) {
  const columns =
    metrics.length === 4
      ? "grid-cols-2 @sm:grid-cols-4"
      : metrics.length === 3
        ? "grid-cols-3"
        : "grid-cols-2";
  return (
    <div
      className={`@container min-w-0 ${embedded ? "" : "rounded-xl border border-line bg-surface"}`}
    >
      <dl aria-label={label} className={`grid ${columns}`}>
        {metrics.map(({ label, value, title }, index) => (
          <div
            key={label}
            className="relative flex min-w-0 flex-col-reverse px-2 py-3 text-center"
          >
            {index > 0 && (
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1/2 h-7 w-px -translate-y-1/2 bg-line ${metrics.length === 4 && index === 2 ? "hidden @sm:block" : ""}`}
              />
            )}
            <dt
              className="mt-1 truncate text-ui-base text-ink-mute"
              data-hint={label}
            >
              {label}
            </dt>
            <dd
              className="truncate text-lg font-medium tabular-nums"
              data-hint={title}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}
