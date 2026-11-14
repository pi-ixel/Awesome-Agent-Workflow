import { type ReactNode } from "react";
export { SegmentedControl } from "./controls/SegmentedControl.tsx";

export const settingsInputClass =
  "h-8 w-full min-w-0 rounded-md border border-line-strong bg-base px-2.5 text-ui-base text-ink placeholder:text-ink-ghost focus:border-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:opacity-50";

/** 多行输入：与单行输入同一套边框、圆角、焦点环，高度可拖。 */
export const settingsTextareaClass =
  "block min-h-16 w-full min-w-0 resize-y rounded-md border border-line-strong bg-base px-2.5 py-1.5 text-ui-base leading-relaxed text-ink placeholder:text-ink-ghost focus:border-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:opacity-50";

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
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
        {children}
      </div>
    </div>
  );
}

/** 设置行：左「标题 + 说明」右控件；footer 承接状态行 / 推导提示等
 * 附属信息（占整行宽，视觉上仍是本行的一部分）。 */
export function SettingRow({
  label,
  desc,
  htmlFor,
  footer,
  footerAlign = "end",
  children,
}: {
  readonly label: string;
  readonly desc?: string;
  /** 可聚焦控件（input）的关联 id；纯展示行省略。 */
  readonly htmlFor?: string;
  readonly footer?: ReactNode;
  readonly footerAlign?: "start" | "end";
  readonly children?: ReactNode;
}) {
  return (
    <div className="border-t border-line px-4 py-3 first:border-t-0">
      <div className="grid grid-cols-1 items-center gap-2.5 gap-y-1 @min-[560px]/settings:grid-cols-[minmax(0,1fr)_minmax(0,240px)] @min-[560px]/settings:gap-4">
        <div className="min-w-0">
          {htmlFor !== undefined ? (
            <label
              htmlFor={htmlFor}
              className="block text-ui-base font-medium text-ink"
            >
              {label}
            </label>
          ) : (
            <span className="block text-ui-base font-medium text-ink">
              {label}
            </span>
          )}
          {desc !== undefined && desc.length > 0 ? (
            <p className="mt-1 text-ui-caption leading-relaxed text-ink-mute">
              {desc}
            </p>
          ) : null}
        </div>
        {children !== undefined ? (
          <div className="flex min-w-0 items-center justify-start gap-2 @min-[560px]/settings:justify-end">
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
