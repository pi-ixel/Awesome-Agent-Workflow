/**
 * 会话条目的时间展示工具：时长（工具卡 / 思考块的耗时）与时钟（hover
 * 时间戳）。从 ThoughtBlock 的私有实现提炼共享——格式保持一致，避免
 * 同屏出现两种「1m05s」。
 */

/** 毫秒 → 人读时长（<1s 保留一位小数，其余取整；≥1s<1m 为 `Ns`，之上 `Nm Ns`）。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 回合头「已工作」行的长耗时格式（对齐 ZCode）：`X 小时 Y 分` / `X 分 Y 秒` / `X 秒`。 */
export function formatWorkDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 时间戳 → `HH:MM:SS`（本地时区）；withSeconds=false 时为 `HH:MM`（ZCode
 * 动作行样式）。空值 / 非法值返回 null（调用方不渲染 title）。 */
export function formatClock(
  input: string | number | null,
  withSeconds = true,
): string | null {
  const date =
    typeof input === "number"
      ? new Date(input)
      : input !== null && input.length > 0
        ? new Date(input)
        : null;
  if (date === null || Number.isNaN(date.getTime())) {
    return null;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (!withSeconds) return `${hh}:${mm}`;
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** 消息动作行时间（对齐 ZCode messageTimeLabel 分层）：今天 `HH:MM`、
 * 昨天 `昨天 HH:MM`、同年 `M月D日 HH:MM`、跨年 `YYYY年M月D日`。 */
export function formatActionClock(input: string | number | null): string | null {
  const date =
    typeof input === "number"
      ? new Date(input)
      : input !== null && input.length > 0
        ? new Date(input)
        : null;
  if (date === null || Number.isNaN(date.getTime())) {
    return null;
  }
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const hm = `${hh}:${mm}`;
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round(
    (startOfDay(now) - startOfDay(date)) / 86_400_000,
  );
  if (dayDelta === 0) return hm;
  if (dayDelta === 1) return `昨天 ${hm}`;
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === now.getFullYear()) return `${monthDay} ${hm}`;
  return `${date.getFullYear()}年${monthDay}`;
}
