/** 右键/下拉菜单宿主控制器（与 ContextBar 的 useBarMenuController 同拍）：
 *  onDismiss 只置 closing 播 100ms 退场动画，100ms 后卸载。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextMenuEntry, MenuPlacement } from "../../ContextMenu.tsx";

export const MENU_CLOSE_MS = 100;

export interface MenuState {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly closing: boolean;
}

export function useMenuController(): {
  menu: MenuState | null;
  open: (
    id: string,
    label: string,
    entries: readonly ContextMenuEntry[],
    placement: MenuPlacement,
  ) => void;
  dismiss: () => void;
} {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setMenu((current) =>
      current === null || current.closing ? current : { ...current, closing: true },
    );
    if (closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setMenu(null);
      }, MENU_CLOSE_MS);
    }
  }, []);

  const open = useCallback(
    (
      id: string,
      label: string,
      entries: readonly ContextMenuEntry[],
      placement: MenuPlacement,
    ) => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setMenu({ id, label, entries, placement, closing: false });
    },
    [],
  );

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  return { menu, open, dismiss };
}
