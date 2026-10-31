/**
 * Git 状态符号与着色（对齐 ZCode workspace-file-tree/statusStyles.ts）：
 *
 * - 字母只有 M/A/D/R/U 五种，ignored 无字母且不改行名色；
 * - 行名全色 text-*、字母 70% 透明、目录圆点 60% 透明（三套透明度）；
 * - 色板对齐 desktop index.css 语义 token：warn=modified(#ff8a30/#e07b00)、
 *   ok=added/untracked(#46bf72/#1e8a3e)、danger=deleted(#ff5c5c/#e03131)、
 *   info=renamed(#4099ff/#0b7fff)——与 ZCode zai 主题 --color-git-* 逐值一致。
 */
import type { FileTreeGitStatus } from "./model.ts";

export const GIT_STATUS_LABELS: Record<FileTreeGitStatus, string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  untracked: "未跟踪",
  ignored: "已忽略",
};

export function getGitStatusIndicator(
  status: FileTreeGitStatus,
): string | null {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "ignored":
      return null;
  }
}

/** 行名/目录名文字色（目录名 = 自身状态 ?? 聚合[0]）。 */
export function getGitStatusTextClass(
  status: FileTreeGitStatus,
): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-ok";
    case "deleted":
      return "text-danger";
    case "renamed":
      return "text-info";
    case "modified":
      return "text-warn";
    case "ignored":
      return "text-ink-subtlest";
  }
}

/** 行尾字母徽标：同色 70% 透明。 */
export function getGitStatusIndicatorClass(
  status: FileTreeGitStatus,
): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-ok/70";
    case "deleted":
      return "text-danger/70";
    case "renamed":
      return "text-info/70";
    case "modified":
      return "text-warn/70";
    case "ignored":
      return "text-ink-subtlest";
  }
}

/** 目录聚合圆点：bg-*-60。 */
export function getGitStatusDotClass(status: FileTreeGitStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "bg-ok/60";
    case "deleted":
      return "bg-danger/60";
    case "renamed":
      return "bg-info/60";
    case "modified":
      return "bg-warn/60";
    case "ignored":
      return "bg-ink-subtlest/60";
  }
}
