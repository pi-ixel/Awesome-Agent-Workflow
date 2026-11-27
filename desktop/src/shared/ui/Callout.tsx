import { IconButton } from "./IconButton.tsx";
/**
 * 提示条：错误、警告、需要用户处理的事、普通说明，全站一种写法。
 *
 * 短提示的图标、标题首行和控件对齐。空间不足时操作组换行。
 * 带说明或详情的提示条沿正文顶对齐。
 */
import { UiIcon } from "./UiIcon.tsx";
import type { ReactNode } from "react";
import { Disclosure } from "./Disclosure.tsx";
import { XIcon } from "./icons.tsx";
import { keyboardFocusClass } from "./controls.tsx";

export type CalloutTone = "danger" | "warn" | "info" | "ok" | "neutral";

const toneClass: Readonly<Record<CalloutTone, string>> = {
  danger: "border-danger-line bg-danger-bg/50",
  warn: "border-warn-line bg-warn-bg/50",
  info: "border-info-line bg-info-bg/50",
  ok: "border-ok-line bg-ok-bg/50",
  neutral: "border-line-strong bg-surface",
};

const iconClass: Readonly<Record<CalloutTone, string>> = {
  danger: "text-danger-ink",
  warn: "text-warn-ink",
  info: "text-info-ink",
  ok: "text-ok-ink",
  neutral: "text-ink-mute",
};

function ToneIcon({ tone }: { readonly tone: CalloutTone }) {
  return (
    <UiIcon
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mt-0.5 ui-icon-16 shrink-0 ${iconClass[tone]}`}
    >
      {tone === "warn" ? (
        <>
          <path d="M8 2.5 14 13H2Z" />
          <path d="M8 6.5v3M8 11.3v.1" />
        </>
      ) : tone === "ok" ? (
        <>
          <circle cx="8" cy="8" r="5.8" />
          <path d="m5.6 8.2 1.7 1.7 3.2-3.6" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="5.8" />
          {tone === "danger" ? (
            <path d="M8 5v3.4M8 10.9v.1" />
          ) : (
            <path d="M8 7.3v3.6M8 5.2v.1" />
          )}
        </>
      )}
    </UiIcon>
  );
}

export function Callout({
  tone = "warn",
  title,
  children,
  details,
  actions,
  icon,
  onDismiss,
  dismissLabel = "关闭提示",
  role = "alert",
  label,
  floating = false,
  className = "",
}: {
  readonly tone?: CalloutTone;
  /** 首行：发生了什么（一句人话）。 */
  readonly title: ReactNode;
  /** 说明与下一步；也可以放列表等更多内容。 */
  readonly children?: ReactNode;
  /** 折叠在「详情」里的技术信息（错误码、原文）。 */
  readonly details?: ReactNode;
  /** 右侧的操作按钮，最多两个。 */
  readonly actions?: ReactNode;
  readonly icon?: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  /** 需要立刻提醒用 alert（默认）；常驻的说明用 status 或 note。 */
  readonly role?: "alert" | "status" | "note" | "group";
  readonly label?: string;
  readonly floating?: boolean;
  readonly className?: string;
}) {
  const hasBody =
    children !== undefined && children !== null && children !== false;
  const hasDetails =
    details !== undefined && details !== null && details !== false;
  const compact = !hasBody && !hasDetails;
  const rowHeight = actions
    ? "[--callout-row:max(1lh,1.75rem)]"
    : onDismiss
      ? "[--callout-row:max(1lh,24px)]"
      : "[--callout-row:max(1lh,calc(var(--ui-icon-unit)*16))]";
  return (
    <div
      role={role}
      aria-label={label}
      className={`flex items-start gap-2.5 ${floating ? "rounded-popover" : "rounded-control"} border px-3 py-2 text-ui-sm text-ink ${toneClass[tone]} ${compact ? rowHeight : ""} ${className}`}
    >
      <div
        className={`flex min-w-0 flex-1 items-start gap-x-2.5 ${compact ? "flex-wrap gap-y-1.5" : ""}`}
      >
        <div
          className={`flex min-w-0 items-start gap-2.5 ${compact ? "max-w-full flex-auto" : "flex-1"}`}
        >
          <span
            className={`flex shrink-0 ${compact ? "min-h-(--callout-row) items-center [&>svg]:mt-0" : ""}`}
          >
            {icon ?? <ToneIcon tone={tone} />}
          </span>
          <div
            className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${compact ? "min-h-(--callout-row) pt-[calc((var(--callout-row)-1lh)/2)]" : ""}`}
          >
            <div className="font-medium">{title}</div>
            {hasBody && <div className="mt-0.5 text-ink-soft">{children}</div>}
            {hasDetails && (
              <Disclosure summary="详情" className="mt-1 text-ink-mute">
                <div className="max-h-24 overflow-y-auto font-mono text-ui-xs whitespace-pre-wrap">
                  {details}
                </div>
              </Disclosure>
            )}
          </div>
        </div>
        {actions && (
          <div
            className={`flex shrink-0 flex-wrap items-center gap-1.5 ${compact ? "ml-auto min-h-(--callout-row) max-w-full" : "self-center"}`}
          >
            {actions}
          </div>
        )}
      </div>
      {onDismiss && (
        <div
          className={`-mr-1 flex shrink-0 items-center ${compact ? "min-h-(--callout-row)" : ""}`}
        >
          <IconButton
            iconSize="compact"
            type="button"
            aria-label={dismissLabel}
            data-hint={dismissLabel}
            onClick={onDismiss}
            className={`flex items-center justify-center rounded-control text-ink-mute hover:bg-raised/70 hover:text-ink ${keyboardFocusClass}`}
          >
            <XIcon className="ui-icon-14" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
