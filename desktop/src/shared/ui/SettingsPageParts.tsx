import { useState, type ReactNode } from "react";
export { SegmentedControl } from "./controls/SegmentedControl.tsx";

import { settingsNumberInputClass } from "./inputStyles.ts";
export { fieldSurfaceClass, settingsInputClass, settingsNumberInputClass, settingsTextareaClass } from "./inputStyles.ts";

/** 整数设置在失焦或回车时提交，取整与空值规则由设置项提供。 */
export function IntegerSettingInput({
  label,
  value,
  min,
  max,
  round,
  emptyValue,
  blurOnEnter = false,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly round: (value: number) => number;
  readonly emptyValue: number;
  readonly blurOnEnter?: boolean;
  readonly onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const parsed = draft.trim() === "" ? emptyValue : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, round(parsed)))
      : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (blurOnEnter) event.currentTarget.blur();
        else commit();
      }}
      className={settingsNumberInputClass}
    />
  );
}

export function SettingCard({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div aria-label={label} className="min-w-0">
      <h3 className="mb-2 text-ui-base font-semibold text-ink">{label}</h3>
      <div className="min-w-0 border-b border-line bg-surface">{children}</div>
    </div>
  );
}

/** 设置行：左「标题 + 说明」右控件；footer 承接状态行 / 推导提示等
 * 附属信息（占整行宽，视觉上仍是本行的一部分）。 */
export function SettingRow({
  density = "standard",
  id,
  label,
  desc,
  htmlFor,
  footer,
  footerAlign = "end",
  children,
}: {
  readonly density?: "standard" | "compact";
  readonly id?: string;
  readonly label: string;
  readonly desc?: string;
  /** 可聚焦控件（input）的关联 id；纯展示行省略。 */
  readonly htmlFor?: string;
  readonly footer?: ReactNode;
  readonly footerAlign?: "start" | "end";
  readonly children?: ReactNode;
}) {
  const compact = density === "compact";
  const labelClass = compact
    ? "block text-ui-sm text-ink-soft"
    : "block text-ui-base font-medium text-ink";
  return (
    <div
      id={id}
      className={
        compact
          ? "@container/task-row px-4 py-1.5 text-ui-sm"
          : "border-t border-line py-4 first:border-t-0"
      }
    >
      <div
        className={
          compact
            ? "grid min-h-9 grid-cols-1 items-center gap-1 @min-[240px]/task-row:grid-cols-[auto_minmax(0,1fr)] @min-[240px]/task-row:gap-4"
            : "grid grid-cols-1 items-center gap-2.5 gap-y-1 @min-[560px]/settings:grid-cols-[minmax(0,1fr)_minmax(0,240px)] @min-[560px]/settings:gap-4"
        }
      >
        <div className="min-w-0">
          {htmlFor !== undefined ? (
            <label htmlFor={htmlFor} className={labelClass}>
              {label}
            </label>
          ) : (
            <span className={labelClass}>{label}</span>
          )}
          {desc !== undefined && desc.length > 0 ? (
            <p className="mt-1 text-ui-caption leading-relaxed text-ink-mute">
              {desc}
            </p>
          ) : null}
        </div>
        {children !== undefined ? (
          <div
            className={
              compact
                ? "min-w-0 max-w-full @min-[240px]/task-row:justify-self-end"
                : "flex min-w-0 items-center justify-start gap-2 [overflow-wrap:anywhere] @min-[560px]/settings:justify-end"
            }
          >
            {children}
          </div>
        ) : null}
      </div>
      {footer !== undefined ? (
        <div
          className={`mt-2 flex ${footerAlign === "end" ? "justify-end" : "justify-start"}`}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
