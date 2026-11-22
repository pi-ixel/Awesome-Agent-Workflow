/**
 * 统一控件样式与自绘基础控件（ui 层共享的视觉 token）。
 *
 * 颜色一律引用语义 token 工具类（bg-base / text-ink / border-line /
 * text-ok-ink …，定义见 src/index.css 的 @theme）：暗夜与暖白两套主题
 * 下的具体色值由根元素 `theme-warm` 类切换，本文件不写死 neutral-*。
 *
 * 字号刻度同样来自 @theme，全站只有四档（见 index.css 的说明表）：
 * text-2xs(11) / text-xs(12) / text-md(13) / text-sm(14)。组件不写任意
 * 字号，需要更小就往 2xs 并，不再造新档。
 *
 * 按钮三级体系（叠加尺寸类使用，如 `px-3 py-1.5 text-sm`）：
 * - primary：主题正文色实底，只给真正的主操作（发送 / 提交回答 / 新建会话），
 *   禁用态半透明后与可用态依旧可辨；
 * - secondary：描边植面，常规操作（选择目录 / 刷新 / 测试连接）；
 * - ghost：纯文字植面，弱操作与取消（上一步 / 取消）；
 * - danger：浅红底色，危险动作（拒绝审批 / 停止运行）。
 * 全站按钮一律从这里取植面，避免同级操作出现多种植面。
 *
 * 徽标统一走 `Badge tone`：从前有三套配方（描边 / 实底 / 描边+半透底）
 * 各自为政，同一个界面里同名状态长得不一样；现在一份配方 + 五种 tone。
 *
 * 自绘 checkbox / radio：不再露出原生白色控件。
 * 原生 input 保留（表单语义、键盘与测试兼容），仅视觉隐藏（sr-only），
 * 视觉态由受控的指示器 span 呈现，accent 统一为 sky。
 * 列表选择一律用 `Listbox`（或自身的自绘下拉）而不是原生 `<select>`：
 * 原生下拉的展开列表由操作系统绘制，CSS 管不到——暗夜主题下会弹出
 * 一块系统白底列表。
 */

/**
 * 键盘焦点指示环（focus-visible 体系）：可交互元素的统一键盘焦点样式。
 * 只在键盘聚焦（focus-visible）时显示中性细环并隐藏默认 outline，
 * 鼠标点击不出现（保留浏览器默认 focus 语义的工具类出口）。
 */
import { UiIcon } from "./UiIcon.tsx";
import { forwardRef, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { useAnchoredPopover } from "./controls/useAnchoredPopover.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";

export const focusVisibleRing =
  "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none";

/** 各级按钮的公共底样式（尺寸由调用处叠加）。 */
const btnBase = `press rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${focusVisibleRing}`;

/**
 * 按钮尺寸（高度 + 内边距 + 不换行）：同组按钮同高用的那一档。
 * 从前 InlineConfirm 和工作流面板各写了一份同样的类串，改一处漏一处。
 */
export const btnSize =
  "inline-flex min-h-7 shrink-0 items-center justify-center gap-1 px-2.5 py-0.5 text-ui-sm leading-tight whitespace-nowrap";

/** 主操作：主题正文色实底，文字使用对应的反色。 */
export const btnPrimary = `${btnBase} bg-ink text-foreground-inverse enabled:hover:bg-ink/90`;

/** 常规操作：描边植面。 */
export const btnSecondary = `${btnBase} border border-line-strong bg-surface text-ink enabled:hover:border-ink-faint enabled:hover:bg-raised`;

/** 弱操作 / 取消：纯文字植面。 */
export const btnGhost = `${btnBase} text-ink-mute enabled:hover:bg-raised/70 enabled:hover:text-ink`;

/** 危险操作：浅红底色。 */
const btnDanger = `${btnBase} bg-danger-bg text-danger-ink enabled:hover:bg-danger-bg/70`;

const actionTones = {
  primary: btnPrimary,
  secondary: btnSecondary,
  ghost: btnGhost,
  danger: btnDanger,
  "danger-solid": `${btnBase} bg-danger-solid text-danger-solid-ink enabled:hover:bg-danger-solid-hover`,
  media: `${btnBase} border border-media-ink/30 text-media-ink enabled:hover:bg-media-ink/10`,
};
export const ActionButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  readonly tone: keyof typeof actionTones;
  readonly size?: "compact";
}>(function ActionButton({ tone, size, className = "", type = "button", ...props }, ref) {
  return <button {...props} ref={ref} type={type} className={`${actionTones[tone]} ${size === "compact" ? btnSize : ""} ${className}`} />;
});

export const DangerButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  function DangerButton({ className = "", type = "button", ...props }, ref) {
    return <ActionButton {...props} ref={ref} type={type} tone="danger" className={className} />;
  },
);

/** 分段导航（tab）激活 / 非激活态：中性 selected 植面（Zai 同款，无色相）。 */
export const tabActiveClass = "bg-(--color-selected) font-medium text-ink";
export const tabInactiveClass = "text-ink-mute hover:text-ink";

/**
 * 列表行的选中态：中性 selected 植面（Zai 同款：暗白 10% / 浅黑 5%，随
 * 主题切换）——与 ZCode 行选中单一配方一致（TaskListItem.tsx:577
 * isActive ? "bg-selected"），不加左缘竖条等自创修饰：选中是「你在这」
 * 的整块底色，竖条会与 hover 植面形成两套高亮语言。
 */
export const rowSelectedClass = "bg-(--color-selected)";

/**
 * 进度条（自绘，不用浏览器默认样式）：
 * - 轨道内凹感：base 底 + inset 描边；
 * - 填充 accent 渐变 + 右端圆头，宽度变化带过渡；完成后切换 emerald
 *   渐变（「全部完成」一眼可辨）。
 * 尺寸由调用处用 className 叠加（如 `h-1 w-20`、`h-1.5 flex-1`）。
 */
export interface ProgressBarProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  /** 追加到轨道上的尺寸类（宽度 / 高度）。 */
  readonly className?: string;
}

export function ProgressBar({
  label,
  value,
  max,
  className = "h-1.5 w-full",
}: ProgressBarProps) {
  const hasTotal = Number.isFinite(max) && max > 0;
  const now = hasTotal && Number.isFinite(value)
    ? Math.min(max, Math.max(0, value))
    : undefined;
  const percent = now === undefined ? 0 : Math.round((now / max) * 100);
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={hasTotal ? max : undefined}
      aria-valuenow={now}
      className={`inline-block overflow-hidden rounded-full bg-base ring-1 ring-inset ring-line-strong/60 ${className}`}
    >
      <span
        className={`block h-full rounded-r-full transition-[width] duration-300 motion-reduce:transition-none ${
          now === max
            ? "bg-gradient-to-r from-ok to-ok-ink"
            : "bg-gradient-to-r from-info to-accent-ink-strong"
        }`}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** 自绘 radio 指示器：外圈 + 选中时填充点（accent 描边 + 填充强化辨识）。
 *  视觉隐藏的原生 input 承担键盘焦点，经 peer-focus-visible 显环。 */
export function RadioDot({
  checked,
  appearance = "accent",
}: {
  readonly checked: boolean;
  readonly appearance?: "accent" | "neutral";
}) {
  return (
    <span
      aria-hidden={true}
      className={`flex ui-icon-16 shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring peer-focus-visible:outline-none ${
        checked
          ? appearance === "neutral"
            ? "border-ink bg-surface"
            : "border-accent-ink bg-info-bg"
          : "border-line-strong bg-base"
      }`}
    >
      <span
        className={`ui-icon-8 rounded-full transition-colors ${
          checked
            ? appearance === "neutral"
              ? "bg-ink"
              : "bg-accent-ink"
            : "bg-transparent"
        }`}
      />
    </span>
  );
}

/** 带可点击标签的复选框，使用原生输入处理焦点与空格键。 */
export function Checkbox({
  label,
  accessibleName,
  appearance = "label",
  checked,
  disabled = false,
  onChange,
  className = "inline-flex items-center gap-2 text-ui-sm",
}: {
  readonly label: ReactNode;
  readonly accessibleName?: string;
  readonly appearance?: "label" | "pill";
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly className?: string;
}) {
  // 将视觉隐藏的原生输入定位在标签内，避免聚焦时滚动外层弹窗。
  return (
    <label
      className={`relative ${className} ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        aria-label={accessibleName}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {appearance === "pill" ? (
        <span
          className={`grid min-h-8 min-w-8 place-items-center rounded-full text-ui-base transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring ${
            checked
              ? "bg-ink text-foreground-inverse"
              : "text-ink-soft peer-enabled:hover:bg-surface-hover"
          }`}
        >
          {label}
        </span>
      ) : (
        <>
          <span
            aria-hidden="true"
            className={`flex ui-icon-16 shrink-0 items-center justify-center rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring ${
              checked ? "border-info-ink bg-info-bg" : "border-line-strong bg-base"
            }`}
          >
            <UiIcon
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`ui-icon-12 ${checked ? "text-info-ink" : "invisible"}`}
            >
              <path d="M2.5 6.5 5 9l4.5-6" />
            </UiIcon>
          </span>
          <span className="min-w-0 flex-1">{label}</span>
        </>
      )}
    </label>
  );
}

export interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly onChange: (next: boolean) => void;
  /** 可访问名称（原生 input 的 aria-label）。 */
  readonly label: string;
}

/** 自绘开关（滑块式）：原生 checkbox 视觉隐藏，仅承担语义与键盘。 */
export function ToggleSwitch({
  checked,
  disabled = false,
  pending = false,
  onChange,
  label,
}: ToggleSwitchProps) {
  return (
    <label
      className={`relative inline-flex min-h-6 shrink-0 items-center justify-center ${pending ? "cursor-wait opacity-70" : disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        onChange={(event) => {
          if (!pending) onChange(event.target.checked);
        }}
        className="peer sr-only"
      />
      <span
        aria-hidden={true}
        className={`relative h-[calc(18*var(--ui-icon-unit))] w-[calc(32*var(--ui-icon-unit))] shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring ${checked ? "border-ink bg-ink" : "border-transparent bg-ink/30"}`}
      >
        <span
          className={`ui-icon-14 absolute top-1/2 -translate-y-1/2 rounded-full bg-base transition-[left] motion-reduce:transition-none ${checked ? "left-[calc(100%_-_15*var(--ui-icon-unit))]" : "left-[var(--ui-icon-unit)]"}`}
        />
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// 徽标（Badge）：全站唯一配方
// ---------------------------------------------------------------------------

/** 徽标语气：中性 / 通过 / 警告 / 危险 / 信息（对应语义 token 三件套）。 */
export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

/**
 * 徽标配方（一份，五种语气）：实底淡植面 + 同色描边 + 语义文字色。
 *
 * 从前有三个各写一半的配方（纯描边 / 纯实底 / 描边+半透底），同一个
 * 「已连接」在不同位置长得不一样；这里收成一份，需要别的语气就选 tone。
 */
const badgeToneClass: Readonly<Record<BadgeTone, string>> = {
  neutral: "border-line-strong bg-base text-ink-mute",
  ok: "border-ok-line bg-ok-bg/50 text-ok-ink",
  warn: "border-warn-line bg-warn-bg/50 text-warn-ink",
  danger: "border-danger-line bg-danger-bg/50 text-danger-ink",
  info: "border-info-line bg-info-bg/50 text-info-ink",
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** 悬停提示（可选）。 */
  readonly title?: string;
  /** 紧凑态：只留极小的内边距（树行 / 行尾徽标）。 */
  readonly compact?: boolean;
  readonly children: React.ReactNode;
}

/** 徽标（胶囊）：文字 + 可选小圆点；尺寸走 text-2xs 一档。 */
export function Badge({
  tone = "neutral",
  title,
  compact = false,
  children,
}: BadgeProps) {
  return (
    <span
      data-hint={title}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded border text-2xs [overflow-wrap:anywhere] ${badgeToneClass[tone]} ${
        compact ? "px-1 py-0.5" : "px-1.5 py-0.5"
      }`}
    >
      {children}
    </span>
  );
}

/** 徽标里的状态圆点（颜色随父级 currentColor，与徽标同色系）。 */
export function BadgeDot({
  className = "ui-icon-6",
  pulse = false,
}: {
  readonly className?: string;
  readonly pulse?: boolean;
}) {
  return (
    <span
      aria-hidden={true}
      className={`shrink-0 rounded-full bg-current ${pulse ? "animate-pulse motion-reduce:animate-none" : ""} ${className}`}
    />
  );
}

/**
 * 独立状态圆点（不在徽标里）：语气 → 颜色，与 Badge 同一套语义 token。
 *
 * 用在列表行、卡片底部这类「只有一个点在说状态」的地方——整列都是同色
 * 徽标时颜色就不是信号了，收成一个点。列表、树、统计里手写的
 * `h-1.5 w-1.5 rounded-full bg-danger` 之类的圆点都应该换到这里。
 */
const dotToneClass: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-line-strong",
  ok: "bg-ok-ink",
  warn: "bg-warn-ink",
  danger: "bg-danger-ink",
  info: "bg-info-ink",
};

export function StatusDot({
  tone = "neutral",
  pulse = false,
  label,
  hint,
  className = "ui-icon-6",
}: {
  readonly tone?: BadgeTone;
  /** 进行中：呼吸闪烁（尊重减少动效设置）。 */
  readonly pulse?: boolean;
  /** 可访问名称；纯装饰（旁边已有状态文字）时省略。 */
  readonly label?: string;
  /** 悬停提示（窗口级 HintTooltip），一般与 label 同文。 */
  readonly hint?: string;
  readonly className?: string;
}) {
  const animation =
    pulse && tone === "info" ? " animate-pulse motion-reduce:animate-none" : "";
  const classes = `inline-block shrink-0 rounded-full ${dotToneClass[tone]} ${className}${animation}`;
  if (label === undefined) {
    return <span aria-hidden={true} data-hint={hint} className={classes} />;
  }
  return <span role="img" aria-label={label} data-hint={hint} className={classes} />;
}

// ---------------------------------------------------------------------------
// 下拉选择（Listbox）：自绘，不用原生 <select>
// ---------------------------------------------------------------------------

export interface ListboxOption {
  readonly value: string;
  readonly label: string;
  readonly group?: string;
}

export interface ListboxProps {
  readonly appearance?: "default" | "quiet";
  readonly triggerLabel?: string;
  readonly showSelectionMark?: boolean;
  /** 可访问名称（触发按钮的 aria-label）。 */
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly ListboxOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** 无值 / 无选项时的显示文案。 */
  readonly placeholder?: string;
  /** 追加到触发按钮的尺寸类（默认 py-1 text-ui-sm）。 */
  readonly className?: string;
  /** 占满父宽（设置页表单）；默认按内容宽度。 */
  readonly fullWidth?: boolean;
}

/**
 * 自绘下拉：触发按钮 + 绝对定位的选项面板。
 *
 * 为什么不用原生 `<select>`：它的**展开列表由操作系统绘制**，CSS 完全
 * 够不到——暗夜主题下点开会弹出一块系统白底列表，是界面上唯一一处
 * 「不属于这个应用」的控件，也是字号 / 圆角 / 悬停态全对不上的地方。
 *
 * 交互与可访问性：触发按钮带 `role="combobox"` + `aria-expanded`，
 * 面板 `role="listbox"`、选项 `role="option"` + `aria-selected`；
 * 键盘支持 Enter / Space / ↓ 打开，↑ ↓ 移动高亮，Enter 选中，Esc 关闭；
 * 点面板外部关闭。焦点始终留在触发按钮上（面板不抢焦点），关闭后回归。
 */
export function Listbox({
  appearance = "default",
  triggerLabel,
  showSelectionMark = false,
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "（无）",
  className = "py-1 text-ui-sm",
  fullWidth = false,
}: ListboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  useAnchoredPopover(isOpen, containerRef, listRef);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel =
    selectedIndex === -1 ? null : (options[selectedIndex]?.label ?? null);
  const activeOptionId = options[activeIndex] === undefined ? undefined : `${listId}-${activeIndex}`;

  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && selected) list.scrollTop = Math.max(0, selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2);
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    const list = listRef.current;
    if (!isOpen || !list || !activeOptionId) return;
    const active = document.getElementById(activeOptionId);
    if (!active) return;
    const reveal = () => {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < list.scrollTop || active.offsetHeight > list.clientHeight) {
        list.scrollTop = top;
      } else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight;
      }
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    observer.observe(active);
    return () => observer.disconnect();
  }, [activeOptionId, isOpen]);

  // 点面板外部关闭（与顶栏待办下拉同一收口模式）
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen]);

  /** 打开时把高亮落在当前值上（无选中则首项）。 */
  const open = (): void => {
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
    setIsOpen(true);
  };

  const commit = (index: number): void => {
    const option = options[index];
    if (option === undefined) {
      return;
    }
    onChange(option.value);
    setIsOpen(false);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (disabled) {
      return;
    }
    if (!isOpen) {
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        open();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      case "Home":
      case "End":
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : Math.max(0, options.length - 1));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        setIsOpen(false);
        return;
      case "Tab":
        setIsOpen(false);
        return;
      default:
        return;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex ${fullWidth ? "w-full" : ""}`}
    >
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen ? activeOptionId : undefined}
        disabled={disabled}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
          } else {
            open();
          }
        }}
        onKeyDown={handleKeyDown}
        className={`inline-flex min-h-7 items-center justify-between gap-2 rounded-md px-2.5 text-left text-ink transition-colors ${appearance === "quiet" ? "border border-transparent bg-transparent enabled:hover:bg-surface-hover" : "border border-line-strong bg-surface enabled:hover:border-ink-faint"} disabled:cursor-not-allowed disabled:opacity-40 ${focusVisibleRing} ${className} ${
          fullWidth ? "w-full" : "min-w-24"
        }`}
      >
        <span className="min-w-0 truncate">{triggerLabel ?? selectedLabel ?? placeholder}</span>
        <ChevronDownIcon className="ui-icon-12 shrink-0 text-ink-faint" />
      </button>
      {isOpen ? (
        <ul
          ref={listRef}
          id={listId}
          popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined}
          role="listbox"
          aria-label={label}
          className={`absolute top-full z-40 mt-1 max-h-64 min-w-full overflow-y-auto border border-line-strong bg-surface py-1 text-ink shadow-floating selection-popup ${showSelectionMark ? "right-0 min-w-40 rounded-xl p-1" : "left-0 rounded-md"}`}
        >
          {options.map((option, index) => (
            <li key={option.value} role={option.group ? "group" : undefined} aria-label={option.group}>
              {option.group && options[index - 1]?.group !== option.group && (
                <span aria-hidden="true" className="block break-words px-2.5 py-1 text-ui-sm text-ink-mute">{option.group}</span>
              )}
              <button
                type="button"
                role="option"
                id={`${listId}-${index}`}
                tabIndex={-1}
                aria-selected={option.value === value}
                onPointerEnter={() => {
                  setActiveIndex(index);
                }}
                onClick={() => {
                  commit(index);
                }}
                className={`flex min-h-7 w-full items-center gap-1.5 px-2.5 text-left text-ui-sm transition-colors ${showSelectionMark ? "min-h-8 rounded-lg py-1.5 tabular-nums" : "py-1"} ${
                  index === activeIndex ? rowSelectedClass : "text-ink-soft"
                }`}
              >
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{option.label}</span>
                {showSelectionMark && option.value === value && <span aria-hidden="true" className="ml-auto">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface MultiListboxOption {
  readonly value: string;
  readonly label: string;
  /** 选项前的图标（如状态图标），以 ui-icon-16 为基准。 */
  readonly icon?: ReactNode;
}

/**
 * 多选下拉：外观、定位、键盘与 Listbox 一致，区别是点选项只勾选 / 取消、面板不收起，
 * 一项都不选等于不筛选（触发按钮显示 emptyLabel）。勾了东西时面板底部给「清除」。
 *
 * 触发按钮的文字：没选 → emptyLabel；一两项 → 用「、」连起来；更多 → 「N 项」加 unit。
 */
export function MultiListbox({
  label,
  values,
  options,
  onChange,
  emptyLabel,
  unit = "项",
  className = "py-1 text-xs",
}: {
  /** 可访问名称（触发按钮与面板的 aria-label）。 */
  readonly label: string;
  readonly values: readonly string[];
  readonly options: readonly MultiListboxOption[];
  readonly onChange: (values: readonly string[]) => void;
  readonly emptyLabel: string;
  /** 选了三项以上时触发按钮写「N {unit}」。 */
  readonly unit?: string;
  readonly className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useAnchoredPopover(isOpen, containerRef, listRef);

  useEffect(() => {
    if (!isOpen) return;
    function handlePointerDown(event: PointerEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const chosen = options.filter((option) => values.includes(option.value));
  const summary = chosen.length === 0 ? emptyLabel
    : chosen.length <= 2 ? chosen.map((option) => option.label).join("、")
    : `${chosen.length} ${unit}`;
  // 保持选项原有的顺序，不按点选先后。
  const toggle = (value: string): void => {
    const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
    onChange(options.map((option) => option.value).filter((item) => next.includes(item)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!isOpen) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(0);
        setIsOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) toggle(option.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleKeyDown}
        className={`inline-flex min-w-24 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-ink transition-colors hover:border-ink-faint ${focusVisibleRing} ${className}`}
      >
        <span className="truncate">{summary}</span>
        <ChevronDownIcon className="ui-icon-12 text-ink-faint" />
      </button>
      {isOpen ? (
        <div
          ref={listRef}
          popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined}
          className="absolute top-full right-0 z-40 mt-1 min-w-40 rounded-xl border border-line-strong bg-surface p-1 shadow-floating selection-popup"
        >
          <ul role="listbox" aria-label={label} aria-multiselectable="true" className="max-h-64 overflow-y-auto">
            {options.map((option, index) => {
              const selected = values.includes(option.value);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onPointerEnter={() => setActiveIndex(index)}
                    onClick={() => toggle(option.value)}
                    className={`relative flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-left text-xs whitespace-nowrap transition-colors ${
                      index === activeIndex ? rowSelectedClass : "text-ink-soft"
                    }`}
                  >
                    {option.icon}
                    {option.label}
                    {selected && <CheckIcon aria-hidden={true} className="pointer-events-none absolute right-2 ui-icon-16 text-ink-subtle" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {values.length > 0 && <>
            <div role="separator" className="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex min-h-8 w-full items-center rounded-lg px-2 text-left text-xs text-ink-mute transition-colors hover:bg-(--color-selected) hover:text-ink"
            >
              清除
            </button>
          </>}
        </div>
      ) : null}
    </div>
  );
}

/** 旋转圆环加载指示（尺寸随字号，颜色随 currentColor）。 */
export function Spinner({
  className = "ui-icon-14",
}: {
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden={true}
      role="status"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none ${className}`}
    />
  );
}
