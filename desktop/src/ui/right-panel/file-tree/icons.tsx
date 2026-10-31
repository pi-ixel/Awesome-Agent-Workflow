/**
 * 文件树/预览专用的补充图标（几何逐字取 lucide-static，24 viewBox、
 * stroke-2，与 src/ui/icons.tsx 的「对齐 ZCode lucide」段同规格）。
 * desktop 统一图标集（../icons.tsx）不允许在本任务改动，缺失的
 * lucide 图标在这里就近补齐；已有同形的（ChevronRight/Search/X/
 * Ellipsis/Copy/Refresh）继续复用统一集。
 */
import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "aria-hidden">;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 打开文件夹（Lucide folder-open）。更多菜单「在文件管理器中打开」。 */
export function FolderOpenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

/** 文件夹（Lucide folder）。预览空态占位图标。 */
export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Svg>
  );
}

/** Git 提交（Lucide git-commit-vertical）。「仅显示变更文件」开关。 */
export function GitCommitVerticalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <line x1="12" x2="12" y1="3" y2="9" />
      <line x1="12" x2="12" y1="15" y2="21" />
    </Svg>
  );
}

/** 加载圈（Lucide loader-circle）。目录加载 spinner / 加载态。 */
export function LoaderCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Svg>
  );
}

/** 警示圈（Lucide circle-alert）。目录读取失败的行尾标记。 */
export function AlertCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </Svg>
  );
}

/** 多文件（Lucide files）。空态图标。 */
export function FilesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 7h-3a2 2 0 0 1-2-2V2" />
      <path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l5 5v9a2 2 0 0 1-2 2Z" />
      <path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
    </Svg>
  );
}

/** 眼睛（Lucide eye）。预览模式单选项。 */
export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** 文件代码（Lucide file-code-2）。源码模式单选项 / 换行开关。 */
export function FileCode2Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m10 12.5-2 2.5 2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
    </Svg>
  );
}

/** 外链（Lucide external-link）。预览头「在编辑器打开」按钮。 */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  );
}
