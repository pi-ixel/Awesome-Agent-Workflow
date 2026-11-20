/** 文件图标沿用 2 单位描边。 */
import { Svg, type IconProps } from "../UiIcon.tsx";

/** Git 提交（Lucide git-commit-vertical）。「仅显示变更文件」开关。 */
export function GitCommitVerticalIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="3" />
      <line x1="12" x2="12" y1="3" y2="9" />
      <line x1="12" x2="12" y1="15" y2="21" />
    </Svg>
  );
}

/** 警示圈（Lucide circle-alert）。目录读取失败的行尾标记。 */
export function AlertCircleIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </Svg>
  );
}

/** 多文件（Lucide files）。空态图标。 */
export function FilesIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M20 7h-3a2 2 0 0 1-2-2V2" />
      <path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l5 5v9a2 2 0 0 1-2 2Z" />
      <path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
    </Svg>
  );
}

/** 眼睛（Lucide eye）。预览模式单选项。 */
export function EyeIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** 外链（Lucide external-link）。预览头「在编辑器打开」按钮。 */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  );
}
