import type { HostStorage } from "../../../contracts/host.ts";

export function clampWidth(width: number, minPx: number, maxPx: number): number {
  return Math.min(maxPx, Math.max(minPx, Math.round(width)));
}

export function readColumnWidth(storage: HostStorage, key: string): number | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

export function saveColumnWidth(storage: HostStorage, key: string, width: number): void {
  try {
    storage.setItem(key, String(width));
  } catch {
    // 栏宽保存失败时继续使用当前布局。
  }
}
