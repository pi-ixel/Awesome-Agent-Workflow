/**
 * 「⋯」更多菜单：把不常用的操作收起来，复用应用共用的下拉菜单。
 */
import { useEffect, useRef, useState } from "react";
import { ContextMenu, type ContextMenuEntry, type MenuPlacement } from "../../../shared/ui/ContextMenu.tsx";
import { EllipsisIcon } from "../../../shared/ui/icons.tsx";
import { iconButton } from "./buttons.ts";

const CLOSE_MS = 100;

export function MoreMenu({ label = "更多", entries }: { label?: string; entries: readonly ContextMenuEntry[] }) {
  const [menu, setMenu] = useState<{ placement: MenuPlacement; closing: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (entries.length === 0) return null;
  const dismiss = () => {
    setMenu((current) => current === null ? null : { ...current, closing: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMenu(null), CLOSE_MS);
  };
  return <>
    <button
      type="button"
      className={`${iconButton} workflow-more`}
      aria-label={label}
      data-hint={label}
      aria-haspopup="menu"
      aria-expanded={menu !== null && !menu.closing}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ placement: { x: rect.right, y: rect.bottom + 4, side: "bottom", align: "end" }, closing: false });
      }}
    >
      <EllipsisIcon className="size-3.5" />
    </button>
    {menu && <ContextMenu
      entries={entries}
      placement={menu.placement}
      label={label}
      closing={menu.closing}
      onDismiss={dismiss}
    />}
  </>;
}
