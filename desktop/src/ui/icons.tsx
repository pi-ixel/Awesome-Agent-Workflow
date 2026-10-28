/**
 * 全应用统一图标集（视觉语言的收口点）：
 *
 * - 一套几何：viewBox 24、stroke 1.8、round cap/join——粗细一致是「图标
 *   体系」的前提，此前散落的 ▾ ▸ ✕ ★ ☆ ＋ 等 Unicode 字符在不同字体下
 *   粗细重心各异，正是界面显廉价的头号来源；
 * - 尺寸经 className 控制（h-3 / h-3.5 / h-4），与文字基线对齐由使用方
 *   的 flex items-center 承担；
 * - 纯装饰图标一律 aria-hidden（语义在按钮的 aria-label / title 上）。
 */
import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "aria-hidden">;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 内容宽度·标准：窄内容列（两侧留白多）。 */
export function WidthStandardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5v14M20 5v14" opacity="0.45" />
      <rect x="9.5" y="6.5" width="5" height="11" rx="1.2" />
    </Svg>
  );
}

/** 内容宽度·宽：宽内容列（两侧留白收窄）。 */
export function WidthWideIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5v14M21 5v14" opacity="0.45" />
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.2" />
    </Svg>
  );
}

/** 内容宽度·全宽：内容铺满（外扩箭头）。 */
export function WidthFullIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 4H4v5M15 20h5v-5M4 4l5.5 5.5M20 20l-5.5-5.5" />
      <path d="M4 13v3M20 11V8" opacity="0.45" />
    </Svg>
  );
}

/** 下折 chevron（展开态 / 下拉指示）。 */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

/** 右指 chevron（收起态 / 可展开指示）。 */
export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

/** 上折 chevron（收起指示 / 已展开的开关）。 */
export function ChevronUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m18 15-6-6-6 6" />
    </Svg>
  );
}

/** 关闭 / 移除 ✕。 */
export function XIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

/** 收藏（实心星）。 */
export function StarFilledIcon(props: IconProps) {
  return (
    <Svg fill="currentColor" strokeWidth={1.2} {...props}>
      <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
    </Svg>
  );
}

/** 未收藏（描边星）。 */
export function StarOutlineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
    </Svg>
  );
}

/** 加号（新增）。 */
export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

/** 星芒（空态 AAW 标记 / 装饰）。 */
export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path
        d="M12 8.5 13.4 11 16 12l-2.6 1L12 15.5 10.6 13 8 12l2.6-1z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

/** 回到底部的纯下箭头。 */
export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14m-7-7 7 7 7-7" />
    </Svg>
  );
}

/** 回到底部（下箭头接底线）。 */
export function ArrowDownToLineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v13" />
      <path d="m6 12 6 6 6-6" />
      <path d="M5 21h14" />
    </Svg>
  );
}

/** 树形从属（会话视角副行的 └ 弯角）。 */
export function CornerDownRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5v8a3 3 0 0 0 3 3h13" />
      <path d="m16 13 4 3-4 3" />
    </Svg>
  );
}

/** 最小化（底横线；窗口控制同款几何）。 */
export function MinimizeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** 最大化切换（方框）。 */
export function MaximizeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </Svg>
  );
}

/** 滑杆组（设置 · 通用分区标）。 */
export function SlidersHorizontalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 4h-7" />
      <path d="M10 4H3" />
      <path d="M21 12h-9" />
      <path d="M8 12H3" />
      <path d="M21 20h-5" />
      <path d="M12 20H3" />
      <path d="M14 2v4" />
      <path d="M8 10v4" />
      <path d="M16 18v4" />
    </Svg>
  );
}

/** 终端（设置 · 工具路径分区标）。 */
export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </Svg>
  );
}

/** 盾牌对勾（设置 · 会话与审批分区标）。 */
export function ShieldCheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}
