/**
 * 行内二次确认（规范：可能中断或撤不回的操作先说清后果，再确认）。
 *
 * 替换触发它的那颗按钮出现在原位；确认期间调用方隐藏相邻操作。
 * 焦点先落在「取消」上，Esc 等同取消——误触不会直接执行。
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ActionButton } from "./controls.tsx";

export function InlineConfirm({
  message,
  confirmLabel,
  cancelLabel = "取消",
  label,
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
  getReturnFocus,
  className = "",
}: {
  /** 确认后会发生什么。 */
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** 这组确认的可访问名称（如「确认删除」）。 */
  readonly label: string;
  readonly tone?: "danger" | "neutral";
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly getReturnFocus?: () => HTMLElement | null | undefined;
  readonly className?: string;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    previous.current = active instanceof HTMLElement ? active : null;
    cancel.current?.focus();
  }, []);
  const dismiss = () => {
    onCancel();
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        (getReturnFocus?.() ?? previous.current)?.focus({
          preventScroll: true,
        });
    });
  };
  return (
    <div
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      className={`flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 ${tone === "danger" ? "bg-danger-bg/60" : "bg-surface"} ${className}`}
    >
      <span
        className={`min-w-0 flex-[1_1_12rem] text-ui-sm ${tone === "danger" ? "text-danger-ink" : "text-ink-soft"}`}
      >
        {message}
      </span>
      <ActionButton
        tone={tone === "danger" ? "danger" : "primary"}
        size="compact"
        disabled={busy}
        onClick={onConfirm}
      >
        {confirmLabel}
      </ActionButton>
      <ActionButton ref={cancel} tone="ghost" size="compact" onClick={dismiss}>
        {cancelLabel}
      </ActionButton>
    </div>
  );
}
