/**
 * 完整视图 slot 上下文：FullViewHost（中央内容区）与 ProjectPanel（右栏）
 * 分属两棵子树，slot（右栏内容区根 div，tab 条下方）由 PanelWorkspace 持有
 * state、ProjectPanel 挂 ref 上报，FullViewHost 读用——对齐 ZCode
 * data-side-pane-content-slot（AnimatedSidePanePanel.tsx:1149-1152）经
 * WorkspaceShellLayout 的 fullViewSlotRef 中转的接线。
 */
import { createContext, useContext } from "react";

export interface RightPanelSlotValue {
  readonly slot: HTMLElement | null;
  readonly setSlot: (element: HTMLElement | null) => void;
}

export const RightPanelSlotContext = createContext<RightPanelSlotValue>({
  slot: null,
  setSlot: () => {},
});

export function useRightPanelSlot(): HTMLElement | null {
  return useContext(RightPanelSlotContext).slot;
}

export function useRightPanelSlotSetter(): (
  element: HTMLElement | null,
) => void {
  return useContext(RightPanelSlotContext).setSlot;
}
