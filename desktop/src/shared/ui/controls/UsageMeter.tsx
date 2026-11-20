import { HintNumber } from "./HintNumber.tsx";

/** 容量和额度共用的用量条，达到额度后仍显示实际占用比例。 */
export function UsageMeter({
  label,
  percent,
  tone = "info",
}: {
  readonly label: string;
  readonly percent: number;
  readonly tone?: "info" | "warn" | "danger";
}) {
  const actual = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  const value = Math.min(100, actual);
  const display = String(Number(actual.toFixed(1)));
  const fill = {
    info: "bg-usage-meter-fill",
    warn: "bg-usage-meter-warn",
    danger: "bg-usage-meter-danger",
  }[tone];

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${display}%`}
      className="relative isolate flex w-full items-center justify-end overflow-hidden rounded-full bg-usage-meter-track px-2 py-0.5 text-ui-sm leading-none font-normal text-usage-meter-ink"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 -z-10 rounded-full ${fill}`}
        style={{ width: `${value}%` }}
      />
      <span className="inline-flex items-baseline gap-px whitespace-nowrap">
        <HintNumber value={display} />
        <span className="text-2xs leading-none">%</span>
      </span>
    </div>
  );
}
