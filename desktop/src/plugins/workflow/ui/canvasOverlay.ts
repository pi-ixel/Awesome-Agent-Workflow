/**
 * 画布上「不随图缩放 / 不随图滚动」的那两层的宿主。
 *
 * 画布内容在 `.workflow-stage` 里整体 `zoom`，任何挂在内容里的东西（包括绝对
 * 定位）都会跟着缩放和滚动。右侧流程导航、下钻上下文条都必须保持稳定尺寸，
 * 所以它们不能长在内容里 —— GraphCanvas 提供宿主节点，画布内容用 portal 挂过去。
 */
import { createContext, useContext } from "react";

export const CanvasOverlayContext = createContext<HTMLElement | null>(null);
/** 画布顶部横条（上下文条）的宿主：占一整行，不叠在图上。 */
export const CanvasStripContext = createContext<HTMLElement | null>(null);

/** 拿到不随图缩放的浮层宿主；还没挂上时返回 null（此时不渲染浮层）。 */
export const useCanvasOverlay = (): HTMLElement | null => useContext(CanvasOverlayContext);
/** 拿到画布顶部横条宿主；还没挂上时返回 null（此时不渲染横条）。 */
export const useCanvasStrip = (): HTMLElement | null => useContext(CanvasStripContext);
