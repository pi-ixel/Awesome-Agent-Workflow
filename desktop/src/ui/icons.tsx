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

/** 对话（Lucide message-circle；完整视图对话 tab / 最小化圆钮）。 */
export function MessageCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </Svg>
  );
}

/** 差异（Lucide file-diff；审查 tab / diff tab 兜底图标）。 */
export function FileDiffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M15 2v5h5" />
      <path d="M10 12H6" />
      <path d="M8 10v4" />
      <path d="M14 18h2" />
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

/** 星芒（空态 AAW 标记 / 装饰）。 */export function SparkleIcon(props: IconProps) {
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

/** 最小化二段（Lucide minimize-2：内收箭头，与 maximize-2 仅箭头朝向相反；
    ZCode SidePaneFullViewToggleButton active 同形）。 */
export function Minimize2Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="20 10 14 10 14 4" />
      <polyline points="4 14 10 14 10 20" />
      <line x1="14" x2="21" y1="10" y2="3" />
      <line x1="3" x2="10" y1="21" y2="14" />
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

/** 进入完整视图（Lucide maximize-2：右上是进、左下是出，ZCode
    SidePaneFullViewToggleButton :22 同形）。 */
export function Maximize2Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" x2="14" y1="3" y2="10" />
      <line x1="3" x2="10" y1="21" y2="14" />
    </Svg>
  );
}

/** 双下折 chevron（标签总览切换器，ZCode SidePaneTabOverview.tsx:152）。 */
export function ChevronsDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m7 6 5 5 5-5" />
      <path d="m7 13 5 5 5-5" />
    </Svg>
  );
}

/** 竖排把手点（完整视图浮窗拖动，ZCode ConversationHost.tsx:534）。 */
export function GripVerticalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
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

/** 手掌（每次询问 / 需要确认类操作标）。 */
export function HandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 11V6a2 2 0 0 0-4 0v4" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </Svg>
  );
}

/** 对勾（菜单 radio 选中指示，ZCode DropdownMenuRadioItem 的 Lucide Check 同款）。 */
export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 6 9 17l-5-5" />
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

/** 文件夹图标：与项目树一致的双态 Lucide 线性图形（收起合口 / 展开开口）。 */
export function FolderGlyph({
  isExpanded,
  className = "h-3.5 w-3.5 shrink-0 text-ink-mute",
}: {
  readonly isExpanded: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className={className}
    >
      {isExpanded ? (
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      )}
    </svg>
  );
}

/** 刷新：双向环形箭头（Lucide refresh-cw）。 */
export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Svg>
  );
}

/** 全部展开：上下双 chevron（Lucide chevrons-up-down）。 */
export function ChevronsUpDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </Svg>
  );
}

/** 全部收起：上下双 chevron 反转（Lucide chevrons-down-up）。 */
export function ChevronsDownUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m7 20 5-5 5 5" />
      <path d="m7 4 5 5 5-5" />
    </Svg>
  );
}

/** 更多：横向三点（Lucide ellipsis）。项目行 hover 动作栏的菜单入口。 */
export function EllipsisIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  );
}

/** 新建会话：对话气泡加号（Lucide message-circle-plus）。 */
export function MessageCirclePlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </Svg>
  );
}

/** 工作流：节点连线图（Lucide workflow）。项目行 hover 动作栏的总览入口。 */
export function WorkflowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </Svg>
  );
}

/** 加载中：八辐条风车（Lucide loader）。运行中回合的尾部 spinner——
 * 旋转容器而非 SVG 本体（ZCode ChatLoading 同款，动画走合成层）。 */
export function LoaderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Svg>
  );
}

/** 思考：脑形图标（Lucide brain）。ZCode reasoning 行的静态 glyph——
 * 源码注释明确不用旋转 loader（长流式下长期占用渲染资源）。 */
export function BrainIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.964 17.484A4 4 0 0 1 18 18" />
    </Svg>
  );
}

/** 搜索 / 读文件（Lucide search）。ZCode read 与 search 工具行同款。 */
export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}

/** 编辑 / 写文件（Lucide pencil）。ZCode edit 工具行同款。 */
export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Svg>
  );
}

/** 终端命令（Lucide square-terminal）。ZCode execute 工具行同款。 */
export function SquareTerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </Svg>
  );
}

/** 网络抓取（Lucide globe）。ZCode web-fetch 工具行同款。 */
export function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Svg>
  );
}

/** 通用工具（Lucide wrench）。ZCode fallback 工具行同款。 */
export function WrenchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </Svg>
  );
}

/** 通用文件（Lucide file）。ZCode read 工具行文件 chip 的基底几何。 */
export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </Svg>
  );
}

/** 视图筛选（Lucide list-filter）。侧栏列表头「切换视角」触发器。 */
export function ListFilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </Svg>
  );
}

/** 时钟（Lucide clock）。视角菜单「最近会话」项。 */
export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  );
}

/* ---------------------------------------------------------------- 新增图标
 * 对齐 ZCode 的 lucide-react 图标（24×24、stroke-2、currentColor）：desktop
 * 统一集的默认线宽是 1.8，本段图标逐个覆写为 2，与 ZCode 顶栏/窗控/菜单里
 * 的同名 lucide 图标同形同重（几何路径逐字取 lucide-static）。
 * ---------------------------------------------------------------------- */

/** 置顶（Lucide pin）。项目置顶菜单项与行前导槽 hover 显现的钉子。 */
export function PinIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Svg>
  );
}

/** 取消置顶（Lucide pin-off）。置顶行菜单的取消项。 */
export function PinOffIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M12 17v5" />
      <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
      <path d="m2 2 20 20" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </Svg>
  );
}

/** 设置齿轮（Lucide settings）。侧栏 footer 的设置入口。 */
export function SettingsIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** 帮助（Lucide circle-help）。顶栏帮助菜单触发器。 */
export function CircleHelpIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

/** 右栏开（Lucide panel-right-open）。右栏收起时顶栏分栏开关的图标。 */
export function PanelRightOpenIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m10 15-3-3 3-3" />
    </Svg>
  );
}

/** 右栏关（Lucide panel-right-close）。与开态同构、箭头反向（ZCode 同名
 *  lucide 图标的双态映射）。 */
export function PanelRightCloseIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m8 9 3 3-3 3" />
    </Svg>
  );
}

/** 左栏开（Lucide panel-left-open）。侧栏收起时（顶栏左端/树带）的开关图标。 */
export function PanelLeftOpenIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </Svg>
  );
}

/** 左栏关（Lucide panel-left-close）。侧栏展开时的开关图标（ZCode
 *  DesktopTopOverlay 同名双态）。 */
export function PanelLeftCloseIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </Svg>
  );
}

/** 诊断（Lucide activity 心跳线）。侧栏 footer 菜单的「诊断」项。 */
export function ActivityIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </Svg>
  );
}

/** 复制（Lucide copy）。顶栏「复制路径」菜单项。 */
export function CopyIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Svg>
  );
}

/** 粘贴（自绘：左向箭头落入剪贴板；lucide clipboard-paste 不在依赖内）。 */
export function ClipboardPasteIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect x="9" y="3" width="12" height="18" rx="2" />
      <path d="M2 12h9" />
      <path d="m7 8 4 4-4 4" />
    </Svg>
  );
}

/** 最大化（ZCode windowIcons.ts 原路径）：圆角方框。 */
export function WindowMaximizeIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M17.4444 5H6.55556C5.69645 5 5 5.69645 5 6.55556V17.4444C5 18.3036 5.69645 19 6.55556 19H17.4444C18.3036 19 19 18.3036 19 17.4444V6.55556C19 5.69645 18.3036 5 17.4444 5Z" />
    </Svg>
  );
}

/** 还原（ZCode windowIcons.ts 原路径）：后框缺角 + 前实框。 */
export function WindowRestoreIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M9 5H13C16.3137 5 19 7.68629 19 11V15" />
      <rect x="5" y="9" width="10" height="10" rx="2" />
    </Svg>
  );
}

/** 归档（Lucide archive）：箱盖 + 箱体。会话右键菜单的归档项。 */
export function ArchiveIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </Svg>
  );
}

/** 向上箭头（Lucide arrow-up）：查找框的上一个结果。 */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Svg>
  );
}
