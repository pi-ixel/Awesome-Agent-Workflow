/**
 * 沙箱 iframe 消息路由：全窗口只挂一个 message 监听，按来源窗口分发给
 * 对应的讲解图；最后一个订阅撤销时移除监听。宿主换肤同样只挂一个观察者。
 */
import {
  isVisualFrameMessage,
  type VisualFrameMessage,
} from "./frameDocument.ts";

type Handler = (message: VisualFrameMessage) => void;

const handlers = new Map<MessageEventSource, Handler>();

function route(event: MessageEvent): void {
  if (event.source === null) return;
  const handler = handlers.get(event.source);
  if (handler === undefined || !isVisualFrameMessage(event.data)) return;
  handler(event.data);
}

const appearanceListeners = new Set<() => void>();
let appearanceObserver: MutationObserver | null = null;
let appearanceFrame = 0;
let appearanceKey = "";

/**
 * 主题指纹：主题类与字号变量。根元素 style 还承载栏宽等布局变量
 * （拖动侧栏时每帧都写），只有指纹变化才需要重新取色推送。
 */
function readAppearanceKey(): string {
  const root = document.documentElement;
  return `${root.className}|${root.style.getPropertyValue("--ui-font-size")}`;
}

function notifyAppearance(): void {
  const key = readAppearanceKey();
  if (key === appearanceKey) return;
  appearanceKey = key;
  if (appearanceFrame !== 0) return;
  // 同一帧内 class 与字号变量可能先后变化，合并成一次采样
  appearanceFrame = window.requestAnimationFrame(() => {
    appearanceFrame = 0;
    for (const listener of appearanceListeners) listener();
  });
}

/**
 * 监听宿主换肤 / 字号：直接观察根元素的 class 与 style。
 * 换肤可能走 View Transition，主题类在过渡回调里异步切换，
 * 跟随 React 状态采样会读到旧颜色，所以以 DOM 实际变化为准。
 */
export function watchHostAppearance(listener: () => void): () => void {
  if (
    appearanceListeners.size === 0 &&
    typeof MutationObserver !== "undefined"
  ) {
    appearanceKey = readAppearanceKey();
    appearanceObserver = new MutationObserver(notifyAppearance);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }
  appearanceListeners.add(listener);
  return () => {
    appearanceListeners.delete(listener);
    if (appearanceListeners.size > 0) return;
    appearanceObserver?.disconnect();
    appearanceObserver = null;
    window.cancelAnimationFrame(appearanceFrame);
    appearanceFrame = 0;
  };
}

export function listenVisualFrame(
  source: Window,
  handler: Handler,
): () => void {
  if (handlers.size === 0) window.addEventListener("message", route);
  handlers.set(source, handler);
  return () => {
    if (handlers.get(source) !== handler) return;
    handlers.delete(source);
    if (handlers.size === 0) window.removeEventListener("message", route);
  };
}
