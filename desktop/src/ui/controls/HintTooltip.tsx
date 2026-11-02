/**
 * 白底悬浮提示(像素级复刻 ZCode 的 tooltip 形态:rounded-lg 描边白卡、
 * px-3 py-1.5 小字)。
 *
 * 用法(替代原生 title,原生黑底提示必须移除,否则两者同显):
 *
 *   const hint = useHintTooltip("归档任务");
 *   <button {...hint} aria-label="归档任务">…</button>
 *
 * - 单例白卡挂 body:全局同屏只有一张,悬停 250ms 淡入,移开即隐藏;
 * - 位置:默认在触发元素上方居中,贴视口上缘自动翻到下方;滚动/resize 即关;
 * - 无依赖自研(不引 radix),卡片样式与 ZCode tooltip.tsx 的 Content 一致。
 */
import { useEffect } from "react";

import { createLogger } from "../../core/logger.ts";

const logger = createLogger("ui");

const HOVER_DELAY_MS = 250;
/** 触发元素距视口上缘不足该值时,提示翻到下方。 */
const FLIP_MARGIN_PX = 56;

let cardEl: HTMLDivElement | null = null;
let showTimer: number | null = null;

function ensureCard(): HTMLDivElement {
  if (cardEl === null) {
    cardEl = document.createElement("div");
    cardEl.setAttribute("role", "tooltip");
    cardEl.className =
      "pointer-events-none fixed z-[60] max-w-xs -translate-x-1/2 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs leading-snug text-ink shadow-md";
    cardEl.style.display = "none";
    cardEl.style.transition = "opacity 120ms ease";
    document.body.appendChild(cardEl);
  }
  return cardEl;
}

function showHint(anchor: HTMLElement, label: string): void {
  const card = ensureCard();
  const rect = anchor.getBoundingClientRect();
  const flip = rect.top < FLIP_MARGIN_PX;
  card.textContent = label;
  card.style.display = "";
  // 先渲染再量宽：nowrap 保证短标签不被截断换行，贴视口左右缘时把
  // 居中锚点收回可容纳范围
  const cardWidth = card.offsetWidth;
  const half = cardWidth / 2 + 8;
  const centerX = rect.left + rect.width / 2;
  const maxCenter = Math.max(half, window.innerWidth - half);
  card.style.left = `${Math.min(Math.max(centerX, half), maxCenter)}px`;
  if (flip) {
    card.style.top = `${rect.bottom + 6}px`;
    card.style.bottom = "";
  } else {
    card.style.top = "";
    card.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  }
  card.style.opacity = "1";
}

function hideHint(): void {
  // 关闭即移除：卡片是 body 级单例，触发元素卸载（Esc 关卡/切视图）时
  // 无人收卡，display:none 仍占 role=tooltip 且永久残留
  if (cardEl !== null) {
    cardEl.remove();
    cardEl = null;
  }
}

function cancelShowTimer(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
}

/**
 * 悬停提示 props:展开到任意可悬停元素上(button / span 等)。元素卸载或
 * 指针移开自动收卡;卡片独立于 React 树,组件重渲染不受影响。
 */
export function useHintTooltip(label: string): {
  onMouseEnter: (event: { currentTarget: HTMLElement }) => void;
  onMouseLeave: () => void;
  onFocus: (event: { currentTarget: HTMLElement }) => void;
  onBlur: () => void;
} {
  useEffect(
    () => () => {
      cancelShowTimer();
      hideHint();
    },
    [label],
  );
  return {
    onMouseEnter: (event) => {
      const target = event.currentTarget;
      cancelShowTimer();
      if (typeof window === "undefined") {
        return;
      }
      showTimer = window.setTimeout(() => {
        showTimer = null;
        try {
          showHint(target, label);
        } catch (error) {
          logger.warn("悬浮提示显示失败", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }, HOVER_DELAY_MS);
    },
    onMouseLeave: () => {
      cancelShowTimer();
      hideHint();
    },
    onFocus: (event) => {
      cancelShowTimer();
      try {
        showHint(event.currentTarget, label);
      } catch {
        // 忽略
      }
    },
    onBlur: () => {
      cancelShowTimer();
      hideHint();
    },
  };
}
