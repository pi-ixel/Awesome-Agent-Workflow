/**
 * 项目页展示用的纯文本工具（UI 层不承载数据变换，只做展示格式化）。
 */

/** 取路径最后一段作为显示名（兼容 Windows 反斜杠与 POSIX 正斜杠）。 */
export function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  if (normalized === "") {
    return path;
  }
  const slash = normalized.lastIndexOf("/");
  const backslash = normalized.lastIndexOf("\\");
  const cut = Math.max(slash, backslash);
  return cut === -1 ? normalized : normalized.slice(cut + 1);
}

/** ISO 时间 → 中文相对时间（刚刚 / N 分钟前 / N 小时前 / 日期）。 */
export function formatLastOpened(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return "";
  }
  const elapsedMs = now.getTime() - time;
  if (elapsedMs < 60_000) {
    return "刚刚";
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.floor(elapsedMs / 60_000)} 分钟前`;
  }
  if (elapsedMs < 86_400_000) {
    return `${Math.floor(elapsedMs / 3_600_000)} 小时前`;
  }
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}
