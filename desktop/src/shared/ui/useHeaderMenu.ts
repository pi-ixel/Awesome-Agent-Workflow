import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextMenuEntry, MenuPlacement } from "./ContextMenu.tsx";

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

/** 菜单状态（id 区分触发器；closing 驱动退场动画）。 */
interface BarMenuState {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly closing: boolean;
}

/** 关闭时先播放退场动画，重新打开会取消待执行的卸载。 */
export function useHeaderMenu(): {
  menu: BarMenuState | null;
  open: (
    id: string,
    label: string,
    entries: readonly ContextMenuEntry[],
    placement: MenuPlacement,
  ) => void;
  dismiss: () => void;
} {
  const [menu, setMenu] = useState<BarMenuState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setMenu((current) =>
      current === null || current.closing
        ? current
        : { ...current, closing: true },
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
