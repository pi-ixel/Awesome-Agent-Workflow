/**
 * 通用复制按钮：点击后把文本写入剪贴板并给出「已复制 / 复制失败」反馈。
 * 剪贴板 API 缺失（旧环境 / 权限被拒）时如实提示失败，不静默。
 *
 * `iconOnly` 变体：静息时只显示图标且随容器 group-hover 才浮现
 * （配合 `revealOnHover`），用于消息卡右上角这类弱操作，避免常驻文字
 * 按钮成为噪音；无障碍名称始终由 label 提供。
 */
import { useState } from "react";

async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 复制图标（静息态）。 */
function CopyIcon() {
  return (
    <svg
      aria-hidden={true}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
      <path d="M9.5 4.5v-1a1.2 1.2 0 0 0-1.2-1.2H3.7A1.2 1.2 0 0 0 2.5 3.5v4.6A1.2 1.2 0 0 0 3.7 9.3h1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden={true}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="m3 7 2.5 2.5L11 4" />
    </svg>
  );
}

export interface CopyButtonProps {
  /** 延迟取文本：点击瞬间才读取最新内容（流式消息也能复制完整文本）。 */
  readonly getText: () => string;
  /** 无障碍名称，缺省「复制」。 */
  readonly label?: string;
  /** 图标模式：静息态只显示图标（反馈文案仍以文字出现）。 */
  readonly iconOnly?: boolean;
  /** 图标模式下的浮现策略：容器 hover / 键盘聚焦时才显示按钮本体。 */
  readonly revealOnHover?: boolean;
}

export function CopyButton({
  getText,
  label = "复制",
  iconOnly = false,
  revealOnHover = false,
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  const handleClick = (): void => {
    void copyText(getText()).then((ok) => {
      setState(ok ? "done" : "failed");
    });
  };

  const revealClass =
    iconOnly && revealOnHover && state === "idle"
      ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      : "";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={
        state === "done" ? "已复制" : state === "failed" ? "复制失败" : label
      }
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs transition-all ${revealClass} ${
        state === "done"
          ? "text-ok-ink"
          : state === "failed"
            ? "text-danger-ink hover:text-danger-ink"
            : "text-ink-faint hover:bg-raised hover:text-ink-soft"
      }`}
    >
      {iconOnly ? state === "done" ? <CheckIcon /> : <CopyIcon /> : null}
      {state !== "idle" ? (
        <span className={iconOnly ? "sr-only" : undefined} aria-live="polite">
          {state === "done" ? "已复制" : "复制失败"}
        </span>
      ) : null}
      {state === "idle" && !iconOnly ? <span>{label}</span> : null}
    </button>
  );
}
