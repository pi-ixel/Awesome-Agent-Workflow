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
 * - primary：accent 实底，只给真正的主操作（发送 / 提交回答 / 新建会话），
 *   禁用态半透明后与可用态依旧可辨；
 * - secondary：描边植面，常规操作（选择目录 / 刷新 / 测试连接）；
 * - ghost：纯文字植面，弱操作与取消（上一步 / 取消）；
 * - danger：红色描边，危险动作（拒绝审批 / 停止运行）。
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
 * 只在键盘聚焦（focus-visible）时显示 accent 细环并隐藏默认 outline，
 * 鼠标点击不出现（保留浏览器默认 focus 语义的工具类出口）。
 */
import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "./icons.tsx";

export const focusVisibleRing =
  "focus-visible:ring-2 focus-visible:ring-sky-500/60 focus-visible:outline-none";

/** 各级按钮的公共底样式（尺寸由调用处叠加）。 */
const btnBase = `press rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${focusVisibleRing}`;

/** 主操作：accent 实底（两主题下均可读，不随语义 token 切换）。 */
export const btnPrimary = `${btnBase} bg-sky-600 text-white hover:bg-sky-500`;

/** 常规操作：描边植面。 */
export const btnSecondary = `${btnBase} border border-line-strong bg-surface text-ink hover:border-ink-faint hover:bg-raised`;

/** 弱操作 / 取消：纯文字植面。 */
export const btnGhost = `${btnBase} text-ink-mute hover:bg-raised/70 hover:text-ink`;

/** 危险操作：红色描边植面。 */
export const btnDanger = `${btnBase} border border-danger-line bg-danger-bg/40 text-danger-ink hover:bg-danger-bg/70`;

/** 分段导航（tab）激活 / 非激活态：中性 selected 植面（Zai 同款，无色相）。 */
export const tabActiveClass = "bg-(--color-selected) font-medium text-ink";
export const tabInactiveClass = "text-ink-mute hover:text-ink";

/**
 * 列表行的选中态：中性 selected 植面（Zai 同款：暗白 10% / 浅黑 5%，随
 * 主题切换）+ 左缘 2px accent 竖条（inset shadow 实现，不占布局、不产生
 * 位移）。
 *
 * 与悬停态分属两套颜色语言：选中是「你在这」（selected 植面），悬停是
 * 「可点」（更弱的 bg-raised）。左缘竖条额外解决相邻行的高亮框彼此贴合、
 * 看着像互相覆盖的问题——选中行有了明确的起始边，不再靠整块底色相认。
 * 竖条颜色写死 sky-500 而不引主题变量：两套主题下都要读出「这是 accent」。
 */
export const rowSelectedClass =
  "bg-(--color-selected) text-ink shadow-[inset_2px_0_0_0_rgb(14_165_233)]";

/**
 * 进度条（自绘，不用浏览器默认样式）：
 * - 轨道内凹感：base 底 + inset 描边；
 * - 填充 accent 渐变 + 右端圆头，宽度变化带过渡；完成后切换 emerald
 *   渐变（「全部完成」一眼可辨）。
 * 尺寸由调用处用 className 叠加（如 `h-1 w-20`、`h-1.5 flex-1`）。
 */
export interface ProgressBarProps {
  readonly value: number;
  readonly max: number;
  /** 追加到轨道上的尺寸类（宽度 / 高度）。 */
  readonly className?: string;
}

export function ProgressBar({
  value,
  max,
  className = "h-1.5 w-full",
}: ProgressBarProps) {
  const percent =
    max <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((value / max) * 100)));
  const isComplete = max > 0 && value >= max;
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`inline-block overflow-hidden rounded-full bg-base ring-1 ring-inset ring-line-strong/60 ${className}`}
    >
      <span
        className={`block h-full rounded-r-full transition-all duration-300 ${
          isComplete
            ? "bg-gradient-to-r from-emerald-500 to-teal-400"
            : "bg-gradient-to-r from-sky-500 to-cyan-400"
        }`}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** 自绘 radio 指示器：外圈 + 选中时填充点（accent 描边 + 填充强化辨识）。
 *  视觉隐藏的原生 input 承担键盘焦点，经 peer-focus-visible 显环。 */
export function RadioDot({ checked }: { readonly checked: boolean }) {
  return (
    <span
      aria-hidden={true}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500/60 peer-focus-visible:outline-none ${
        checked ? "border-sky-500 bg-sky-500/15" : "border-line-strong bg-base"
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full transition-colors ${
          checked ? "bg-sky-400" : "bg-transparent"
        }`}
      />
    </span>
  );
}

/** 自绘 checkbox 指示器：方框 + 选中时的对勾（焦点环同 RadioDot）。 */
export function CheckSquare({ checked }: { readonly checked: boolean }) {
  return (
    <span
      aria-hidden={true}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500/60 peer-focus-visible:outline-none ${
        checked ? "border-sky-500 bg-sky-500/15" : "border-line-strong bg-base"
      }`}
    >
      <svg
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-3 w-3 ${checked ? "text-sky-400" : "text-transparent"}`}
      >
        <path d="M2.5 6.5 5 9l4.5-6" />
      </svg>
    </span>
  );
}

export interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** 可访问名称（原生 input 的 aria-label）。 */
  readonly label: string;
}

/** 自绘开关（滑块式）：原生 checkbox 视觉隐藏，仅承担语义与键盘。 */
export function ToggleSwitch({ checked, onChange, label }: ToggleSwitchProps) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="peer sr-only"
      />
      <span
        aria-hidden={true}
        className={`relative h-3.5 w-7 shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500/60 ${
          checked
            ? "border-sky-500 bg-sky-600/80"
            : "border-line-strong bg-raised"
        }`}
      >
        <span
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition-all ${
            checked ? "left-3.5 bg-white" : "left-[3px] bg-ink-mute"
          }`}
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
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded border text-2xs whitespace-nowrap ${badgeToneClass[tone]} ${
        compact ? "px-1 py-0.5" : "px-1.5 py-0.5"
      }`}
    >
      {children}
    </span>
  );
}

/** 徽标里的状态圆点（颜色随父级 currentColor，与徽标同色系）。 */
export function BadgeDot({
  className = "h-1.5 w-1.5",
}: {
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden={true}
      className={`shrink-0 rounded-full bg-current ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------
// 下拉选择（Listbox）：自绘，不用原生 <select>
// ---------------------------------------------------------------------------

export interface ListboxOption {
  readonly value: string;
  readonly label: string;
}

export interface ListboxProps {
  /** 可访问名称（触发按钮的 aria-label）。 */
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly ListboxOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** 无值 / 无选项时的显示文案。 */
  readonly placeholder?: string;
  /** 追加到触发按钮的尺寸类（默认 py-1 text-xs）。 */
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
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "（无）",
  className = "py-1 text-xs",
  fullWidth = false,
}: ListboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel =
    selectedIndex === -1 ? null : (options[selectedIndex]?.label ?? null);

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
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
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
        disabled={disabled}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
          } else {
            open();
          }
        }}
        onKeyDown={handleKeyDown}
        className={`inline-flex items-center justify-between gap-2 rounded-md border border-line-strong bg-base px-2.5 text-left text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-40 ${focusVisibleRing} ${className} ${
          fullWidth ? "w-full" : "min-w-24"
        }`}
      >
        <span className="truncate">{selectedLabel ?? placeholder}</span>
        <ChevronDownIcon className="h-3 w-3 text-ink-faint" />
      </button>
      {isOpen ? (
        <ul
          role="listbox"
          aria-label={label}
          className="absolute top-full left-0 z-40 mt-1 max-h-64 min-w-full overflow-y-auto rounded-md border border-line-strong bg-surface py-1 shadow-elev-2"
        >
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onPointerEnter={() => {
                  setActiveIndex(index);
                }}
                onClick={() => {
                  commit(index);
                }}
                className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs whitespace-nowrap transition-colors ${
                  index === activeIndex ? rowSelectedClass : "text-ink-soft"
                }`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 旋转圆环加载指示（尺寸随字号，颜色随 currentColor）。 */
export function Spinner({
  className = "h-3.5 w-3.5",
}: {
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden={true}
      role="status"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}
