/**
 * 输入行状态芯片菜单（ZCode 输入栏控件式）：小芯片触发 + 弹在输入卡上方
 * 的轻量菜单（Esc / 点外部关闭；面板内点击选中后自动收起）。
 *
 * Esc 在此被消费（preventDefault）——SessionView 的全局 Esc 停止按
 * defaultPrevented 让位（与 mention 面板同一约定）。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "../icons.tsx";

export function StatusChipMenu({
  label,
  title,
  menuLabel,
  tone = "neutral",
  variant = "default",
  disabled = false,
  children,
}: {
  /** 芯片文案（如「+」「模型名」「手动询问」）。 */
  readonly label: ReactNode;
  /** 芯片悬停提示。 */
  readonly title: string;
  /** 菜单面板的可访问名称。 */
  readonly menuLabel: string;
  /** neutral=中性描边；warn=琥珀警示（如审批「自动放行」激活态）。 */
  readonly tone?: "neutral" | "warn";
  /** 权限菜单使用 ZCode 的紧凑外壳，模型菜单保留现有样式。 */
  readonly variant?: "default" | "permission";
  /** 无内容可选时呈纯展示芯片（如无模型清单）。 */
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 弹层经 Portal 渲染到 body：触发芯片在 overflow-hidden 的输入卡内，
  // 原地绝对定位会被卡片上缘裁掉（只露出下半截）
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) !== true &&
        panelRef.current?.contains(target) !== true
      ) {
        setIsOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
    }
  };

  // ZCode 式触发器：纯文字 + 下箭头，无底色无边框；字号与输入框同级
  // （14px）、墨色用主文字级（ZCode 实测 composer 底行是近黑前景）；
  // warn（自动放行）用琥珀文字色提示放权状态
  const toneClass =
    // warn 用灯级亮黄(ZCode 完全访问同款 text-warning),不是暗棕的 -ink 文字级
    tone === "warn" ? "text-warn" : "text-ink hover:text-ink-soft";

  if (disabled) {
    return (
      <span
        title={title}
        className="shrink-0 px-1 py-0.5 text-xs text-ink-faint"
      >
        {label}
      </span>
    );
  }
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={menuLabel}
        title={title}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          // 视口右缘保护（面板宽 256px）
          setAnchor({
            left: Math.min(rect.left, window.innerWidth - 264),
            top: rect.top,
          });
          setIsOpen((current) => !current);
        }}
        onKeyDown={handleKeyDown}
        className={`flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm transition-colors hover:bg-hover ${toneClass} ${
          isOpen && tone !== "warn" ? "text-ink-soft" : ""
        }`}
      >
        {label}
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {isOpen && anchor !== null
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={menuLabel}
              // 面板内任何点击都收起菜单。必须用冒泡阶段的 onClick：菜单项
              // 的选中（目标阶段）先于面板收起执行；若在捕获阶段关菜单，
              // 同一次点击会先把 Portal 子树连同菜单项的处理器一起卸载，
              // 选中永远不触发（真实浏览器可复现，jsdom 时序掩盖了它）。
              // translateY(-100%) 使面板底边贴在触发芯片上缘（留 6px 间距）
              onClick={() => {
                setIsOpen(false);
              }}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                transform: "translateY(-100%)",
                marginTop: variant === "permission" ? "-4px" : "-6px",
              }}
              className={`z-50 w-64 overflow-hidden border shadow-md composer-pop-up ${variant === "permission" ? "rounded-lg border-border bg-menu p-1 text-ink" : "rounded-xl border-line bg-surface p-2.5"}`}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 菜单分区标题。 */
export function MenuSectionLabel({ text }: { readonly text: string }) {
  return (
    <p className="border-b border-line px-3 py-1.5 text-sm font-medium text-ink-mute">
      {text}
    </p>
  );
}

/** 菜单条目（role=menuitem；选中态打勾）。 */
export function MenuItemButton({
  selected,
  onClick,
  children,
  danger = false,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
        danger
          ? "text-danger-ink hover:bg-danger-bg/40"
          : "text-ink-soft hover:bg-hover"
      }`}
    >
      <span aria-hidden={true} className="w-3 shrink-0 text-ok-ink">
        {selected ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </button>
  );
}

/**
 * 菜单富行（ZCode 式）：图标 + 标题 + 一句描述，选中勾在右端；icon 可省
 * （无图标时文字顶左对齐）。
 */
export function MenuItemRow({
  variant = "default",
  tone = "neutral",
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  readonly variant?: "default" | "permission";
  readonly tone?: "neutral" | "warn";
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description: string;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`relative flex min-h-13 w-full items-start gap-3 rounded-md py-2 text-left font-sans text-ui-base transition-colors ${variant === "permission" ? `pl-2 pr-8 hover:bg-menu-hover ${tone === "warn" ? "text-warn" : "text-ink"}` : `px-2 hover:bg-hover ${selected ? "text-ink" : "text-ink-soft"}`}`}
    >
      {icon !== undefined ? (
        <span aria-hidden={true} className="mt-0.5 shrink-0 [&_svg]:size-4.5">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className={`block text-ui-base ${variant === "permission" ? "leading-relaxed" : "leading-5"}`}
        >
          {title}
        </span>
        <span
          className={`mt-0.5 block text-ui-sm ${variant === "permission" ? `leading-relaxed ${tone === "warn" ? "text-inherit" : "text-ink-subtle"}` : "leading-snug text-ink-mute"}`}
        >
          {description}
        </span>
      </span>
      <span
        aria-hidden={true}
        className={
          variant === "permission"
            ? `pointer-events-none absolute right-2 top-2.5 size-4 ${tone === "warn" ? "text-inherit" : "text-ink-subtle"}`
            : "mt-0.5 size-4 shrink-0 text-ink"
        }
      >
        {selected ? <CheckIcon className="size-4" /> : null}
      </span>
    </button>
  );
}

/** 只读信息行（skills/mcp 清单等，不可选）。 */
export function MenuInfoRow({
  text,
  danger = false,
}: {
  readonly text: string;
  readonly danger?: boolean;
}) {
  return (
    <p
      className={`flex w-full items-start gap-2 px-3 py-1 text-left text-sm ${
        danger ? "text-danger-ink" : "text-ink-soft"
      }`}
    >
      <span aria-hidden={true} className="w-3 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </p>
  );
}
