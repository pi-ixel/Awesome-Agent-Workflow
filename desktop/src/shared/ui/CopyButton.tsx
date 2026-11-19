/**
 * 通用复制按钮：点击后把文本写入剪贴板并给出「已复制 / 复制失败」反馈。
 * 剪贴板 API 缺失（旧环境 / 权限被拒）时如实提示失败，不静默。
 *
 * `iconOnly` 变体：静息时只显示图标且随容器 group-hover 才浮现
 * （配合 `revealOnHover`），用于消息卡右上角这类弱操作，避免常驻文字
 * 按钮成为噪音；无障碍名称始终由 label 提供。
 */
import { UiIcon } from "./UiIcon.tsx";
import { IconButton } from "./IconButton.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

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
    <UiIcon
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ui-icon-14"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
      <path d="M9.5 4.5v-1a1.2 1.2 0 0 0-1.2-1.2H3.7A1.2 1.2 0 0 0 2.5 3.5v4.6A1.2 1.2 0 0 0 3.7 9.3h1" />
    </UiIcon>
  );
}

function CheckIcon() {
  return (
    <UiIcon
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ui-icon-14"
    >
      <path d="m3 7 2.5 2.5L11 4" />
    </UiIcon>
  );
}

export interface CopyButtonProps {
  /** 延迟取文本：点击瞬间才读取最新内容（流式消息也能复制完整文本）。 */
  readonly getText: () => string;
  /** 无障碍名称，缺省「复制」。 */
  readonly label?: string;
  /** 图标模式：静息态只显示图标（反馈文案仍以文字出现）。 */
  readonly iconOnly?: boolean;
  readonly icon?: ReactNode;
  readonly tone?: "faint" | "muted" | "soft";
  /** 图标模式下的浮现策略：容器 hover / 键盘聚焦时才显示按钮本体。 */
  readonly revealOnHover?: boolean;
  /**
   * 图标模式的尺寸：「sm」(缺省) 24×24 紧凑热区；「md」28×28 rounded-lg
   * 头栏热区（对齐 ZCode Button size="icon-md"），代码块头栏等密集
   * 动作行使用。
   */
  readonly size?: "sm" | "md";
}

/** 复制成功反馈自动回落时长（ZCode CodeBlockCopyButton 同款 2s）。 */
const COPY_FEEDBACK_TIMEOUT_MS = 2_000;

export function CopyButton({
  getText,
  label = "复制",
  iconOnly = false,
  icon,
  tone = "faint",
  revealOnHover = false,
  size = "sm",
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const revertTimerRef = useRef<number | null>(null);

  // 卸载清理回落 timer，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (revertTimerRef.current !== null) {
        window.clearTimeout(revertTimerRef.current);
      }
    },
    [],
  );

  const handleClick = (): void => {
    // done 期间不重复复制（ZCode if (!isCopied) 同款）
    if (state === "done") {
      return;
    }
    void copyText(getText()).then((ok) => {
      if (!ok) {
        setState("failed");
        return;
      }
      setState("done");
      if (revertTimerRef.current !== null) {
        window.clearTimeout(revertTimerRef.current);
      }
      revertTimerRef.current = window.setTimeout(() => {
        revertTimerRef.current = null;
        setState("idle");
      }, COPY_FEEDBACK_TIMEOUT_MS);
    });
  };

  const revealClass =
    iconOnly && revealOnHover && state === "idle"
      ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      : "";

  const sizeClass = iconOnly
    ? size === "md"
      ? "rounded-lg"
      : "rounded"
    : "rounded px-1.5 py-0.5 text-xs";

  const classes = `shrink-0 transition-[color,background-color,opacity] ${sizeClass} ${revealClass} ${
    state === "done"
      ? "text-ok-ink"
      : state === "failed"
        ? "text-danger-ink hover:text-danger-ink"
        : `${tone === "soft" ? "text-ink-soft" : tone === "muted" ? "text-ink-mute" : "text-ink-faint"} hover:bg-raised hover:text-ink-soft`
  }`;
  const feedback = state === "done" ? "已复制" : state === "failed" ? "复制失败" : "";
  const buttonProps = { "aria-label": label, "data-hint": feedback || label, className: classes, onClick: handleClick };
  if (iconOnly) {
    return (
      <>
        <IconButton {...buttonProps} iconSize={size === "md" ? "standard" : "compact"}>
          {state === "done" ? <CheckIcon /> : icon ?? <CopyIcon />}
        </IconButton>
        {feedback && <span className="sr-only" aria-live="polite">{feedback}</span>}
      </>
    );
  }
  return (
    <button type="button" {...buttonProps}>
      {feedback ? <span aria-live="polite">{feedback}</span> : <span>{label}</span>}
    </button>
  );
}
