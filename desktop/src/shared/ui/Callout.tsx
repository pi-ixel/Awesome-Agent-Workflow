/**
 * 提示条：错误、警告、需要用户处理的事、普通说明，全站一种写法。
 *
 * 结构固定：语气图标 → 标题（一句人话）→ 可选说明 → 可选「详情」折叠
 * （错误码、原文）→ 右侧最多两个操作，或一个关闭。颜色只用语义 token，
 * 暗夜 / 暖白两套主题下各自成立。
 */
import type { ReactNode } from "react";
import { Disclosure } from "./Disclosure.tsx";
import { XIcon } from "./icons.tsx";
import { focusVisibleRing } from "./controls.tsx";

export type CalloutTone = "danger" | "warn" | "info" | "ok";

const toneClass: Readonly<Record<CalloutTone, string>> = {
  danger: "border-danger-line bg-danger-bg/50",
  warn: "border-warn-line bg-warn-bg/50",
  info: "border-info-line bg-info-bg/50",
  ok: "border-ok-line bg-ok-bg/50",
};

const iconClass: Readonly<Record<CalloutTone, string>> = {
  danger: "text-danger-ink",
  warn: "text-warn-ink",
  info: "text-info-ink",
  ok: "text-ok-ink",
};

function ToneIcon({ tone }: { readonly tone: CalloutTone }) {
  return (
    <svg
      aria-hidden={true}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mt-0.5 size-4 shrink-0 ${iconClass[tone]}`}
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
          {tone === "danger" ? <path d="M8 5v3.4M8 10.9v.1" /> : <path d="M8 7.3v3.6M8 5.2v.1" />}
        </>
      )}
    </svg>
  );
}

export function Callout({
  tone = "warn",
  title,
  children,
  details,
  actions,
  onDismiss,
  dismissLabel = "关闭提示",
  role = "alert",
  label,
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
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  /** 需要立刻提醒用 alert（默认）；常驻的说明用 status 或 note。 */
  readonly role?: "alert" | "status" | "note" | "group";
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <div
      role={role}
      aria-label={label}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-ui-sm text-ink ${toneClass[tone]} ${className}`}
    >
      <ToneIcon tone={tone} />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div className="font-medium">{title}</div>
        {children !== undefined && children !== null && children !== false && (
          <div className="mt-0.5 text-ink-soft">{children}</div>
        )}
        {details !== undefined && details !== null && details !== false && (
          <Disclosure summary="详情" className="mt-1 text-ink-mute">
            <div className="max-h-24 overflow-y-auto font-mono text-ui-xs whitespace-pre-wrap">{details}</div>
          </Disclosure>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5 self-center">{actions}</div>}
      {onDismiss && (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className={`-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-mute hover:bg-raised/70 hover:text-ink ${focusVisibleRing}`}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
