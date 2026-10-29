/**
 * 栏宽的持久化与恢复（ColumnResizer 与 App 共用的纯逻辑）：
 *
 * - 栏宽经 CSS 变量注入 App 的 grid 模板（`var(--aaw-left-w, 320px)`）；
 * - 拖拽结果持久化到 localStorage，应用启动时在首帧前恢复
 *   （applyPersistedColumnWidths），避免按默认宽渲染后再跳变。
 */

/** 左栏（项目树）宽度的 CSS 变量名与持久化键。 */
export const LEFT_WIDTH_VAR = "--aaw-left-w";
export const LEFT_WIDTH_STORAGE_KEY = "aaw-desktop/layout/zcode-v1/left-w";

/** 宽度默认值与钳制区间（px）。沿用原项目列表栏的区间（树的直接前身）。 */
export const LEFT_DEFAULT_PX = 264;
export const LEFT_MIN_PX = 264;
export const LEFT_MAX_PX = 480;

// 注：图标窄栏（常驻 48px）宽度常量在 IconRail.tsx（ICON_RAIL_WIDTH_PX）；
// 侧边栏收起不再是「44px 窄条」形态，旧窄条组件与其宽度常量已一并退役。

/** 把宽度钳制进 [min, max]。 */
export function clampWidth(
  width: number,
  minPx: number,
  maxPx: number,
): number {
  return Math.min(maxPx, Math.max(minPx, Math.round(width)));
}

/** 从 localStorage 读持久化栏宽；缺失或损坏返回 null。 */
function readPersistedWidth(storageKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入持久化（失败不阻断——栏宽只是偏好，丢得起）。 */
export function persistWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // 持久化失败不影响本次会话内的宽度
  }
}

/** 把变量设置到根元素（统一入口，便于测试断言）。 */
export function setWidthVar(cssVarName: string, width: number): void {
  document.documentElement.style.setProperty(cssVarName, `${width}px`);
}

/** 读取当前生效的栏宽：CSS 变量缺失或非法时回落默认值。 */
export function currentWidthOf(
  cssVarName: string,
  defaultWidthPx: number,
): number {
  const raw = document.documentElement.style.getPropertyValue(cssVarName);
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultWidthPx;
}

/**
 * 首帧前恢复持久化栏宽（App 模块加载时调用一次）：grid 模板引用
 * `var(--aaw-left-w, 320px)`，若恢复晚了会先按默认宽渲染再跳变。
 */
export function applyPersistedColumnWidths(): void {
  const left = readPersistedWidth(LEFT_WIDTH_STORAGE_KEY);
  if (left !== null) {
    setWidthVar(
      LEFT_WIDTH_VAR,
      clampWidth(
        left,
        LEFT_MIN_PX,
        Math.max(LEFT_MIN_PX, window.innerWidth * 0.5),
      ),
    );
  }
}
