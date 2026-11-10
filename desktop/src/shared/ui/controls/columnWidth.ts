interface ColumnWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampWidth(width: number, minPx: number, maxPx: number): number {
  return Math.min(maxPx, Math.max(minPx, Math.round(width)));
}

export function readColumnWidth(storage: Pick<ColumnWidthStorage, "getItem">, key: string): number | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

export function saveColumnWidth(storage: Pick<ColumnWidthStorage, "setItem">, key: string, width: number): void {
  try {
    storage.setItem(key, String(width));
  } catch {
    // 栏宽保存失败时继续使用当前布局。
  }
}
