/** 运行时间的显示（面板、工作流库、项目总览共用）。 */
import { useEffect, useState } from "react";

/** 当前时刻，按间隔刷新（相对时间与用时随之走）。 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(tick);
  }, [intervalMs]);
  return now;
}

/** 时长：「不到 1 分钟」「12 分钟」「1 小时 5 分钟」「2 天 3 小时」。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} 天` : `${days} 天 ${hours % 24} 小时`;
}

/** 「用时 12 分钟」「已运行不到 1 分钟」：前缀与时长之间按读法加空格。 */
export function durationPhrase(prefix: string, ms: number): string {
  const text = formatDuration(ms);
  if (!text) return "";
  return text.startsWith("不到") ? `${prefix}${text}` : `${prefix} ${text}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 开始时刻：今天只写时分，今年写月日时分，更早写年月日。 */
export function formatStart(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === today.toDateString()) return `今天 ${clock} `;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock} `;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `;
}

/** 相对时间：「刚刚」「5 分钟前」「3 小时前」「2 天前」。 */
export function formatAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
