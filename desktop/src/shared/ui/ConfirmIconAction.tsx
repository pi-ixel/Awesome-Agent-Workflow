/**
 * 行尾的「图标 → 确认」动作（归档会话那一套）：点图标变成红色「确认」，
 * 点外面或按 Esc 取消。没在确认时由 revealClassName 决定何时浮现（如悬停行才显示）。
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton.tsx";
import { hintTooltipProps } from "./controls/HintTooltip.tsx";
import { ActionButton, keyboardFocusClass } from "./controls.tsx";

export function ConfirmIconAction({
  label,
  confirmLabel = `确认${label}`,
  disabled = false,
  icon,
  confirming,
  setConfirming,
  onConfirm,
  revealClassName = "",
  className = "",
}: {
  /** 图标的悬停提示与无障碍名称；确认按钮读作「确认{label}」。 */
  readonly label: string;
  readonly confirmLabel?: string;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly confirming: boolean;
  readonly setConfirming: (value: boolean) => void;
  readonly onConfirm: () => void;
  /** 未确认时的可见性类（如 opacity-0 group-hover:opacity-100）。 */
  readonly revealClassName?: string;
  readonly className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (confirming || restoreFocus.current) button.current?.focus();
    restoreFocus.current = false;
  }, [confirming]);
  useEffect(() => {
    if (!confirming) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setConfirming(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoreFocus.current = container.current?.contains(document.activeElement) ?? false;
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [confirming, setConfirming]);
  const hintProps = hintTooltipProps(label);
  return (
    <div
      ref={container}
      className={`flex shrink-0 items-center transition-opacity ${confirming ? "opacity-100" : revealClassName} ${className}`}
    >
      {confirming ? (
        <ActionButton
          ref={button}
          type="button"
          tone="danger-solid"
          aria-label={confirmLabel}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.repeat && event.key === "Enter") event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(false);
            onConfirm();
          }}
          className="px-2 py-0.5 text-ui-sm"
        >
          确认
        </ActionButton>
      ) : (
        <IconButton ref={button} iconSize="compact"
          type="button"
          aria-label={label}
          disabled={disabled}
          {...hintProps}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(true);
          }}
          className={`rounded-control text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${keyboardFocusClass}`}
        >
          {icon}
        </IconButton>
      )}
    </div>
  );
}
