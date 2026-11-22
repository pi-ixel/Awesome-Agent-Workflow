import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextMenuEntry, MenuPlacement } from "./ContextMenu.tsx";

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

/** 菜单状态（id 区分触发器；closing 驱动退场动画）。 */
interface MenuState {
  readonly id: string;
  readonly instance: number;
  readonly label: string;
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly trigger?: HTMLElement;
  readonly closing: boolean;
}

type MenuAnchor = Pick<Partial<MenuPlacement>, "side" | "align"> & {
  readonly trigger: HTMLElement;
};

/** 关闭时先播放退场动画，重新打开会取消待执行的卸载。 */
export function useMenuController(): {
  menu: MenuState | null;
  open: (
    id: string,
    label: string,
    entries: readonly ContextMenuEntry[],
    target: MenuPlacement | MenuAnchor,
  ) => void;
  dismiss: () => void;
} {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const nextInstance = useRef(0);
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
      target: MenuPlacement | MenuAnchor,
    ) => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      const placement: MenuPlacement =
        "trigger" in target
          ? {
              x: 0,
              y: 0,
              side: target.side ?? "bottom",
              align: target.align ?? "end",
            }
          : target;
      const trigger = "trigger" in target ? target.trigger : undefined;
      setMenu({
        id,
        instance: ++nextInstance.current,
        label,
        entries,
        placement,
        trigger,
        closing: false,
      });
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
