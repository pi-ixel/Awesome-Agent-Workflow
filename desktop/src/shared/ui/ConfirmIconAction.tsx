/**
 * 行尾的「图标 → 确认」动作（归档会话那一套）：点图标变成红色「确认」，
 * 点外面或按 Esc 取消。没在确认时由 revealClassName 决定何时浮现（如悬停行才显示）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton.tsx";
import { hintTooltipProps } from "./controls/HintTooltip.tsx";

export function ConfirmIconAction({
  label,
  icon,
  confirming,
  setConfirming,
  onConfirm,
  revealClassName = "",
  className = "",
}: {
  /** 图标的悬停提示与无障碍名称；确认按钮读作「确认{label}」。 */
  readonly label: string;
  readonly icon: ReactNode;
  readonly confirming: boolean;
  readonly setConfirming: (value: boolean) => void;
  readonly onConfirm: () => void;
  /** 未确认时的可见性类（如 opacity-0 group-hover:opacity-100）。 */
  readonly revealClassName?: string;
  readonly className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirming) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setConfirming(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
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
        <button
          type="button"
          aria-label={`确认${label}`}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(false);
            onConfirm();
          }}
          className="contrast-danger-solid rounded-md bg-red-500 px-2 py-0.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
        >
          确认
        </button>
      ) : (
        <IconButton iconSize="compact"
          type="button"
          aria-label={label}
          {...hintProps}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(true);
          }}
          className="rounded text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          {icon}
        </IconButton>
      )}
    </div>
  );
}
