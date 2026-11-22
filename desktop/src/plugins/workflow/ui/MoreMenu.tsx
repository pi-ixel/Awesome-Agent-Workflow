import { IconButton } from "../../../shared/ui/IconButton.tsx";
import type { Ref } from "react";
/**
 * 「⋯」更多菜单：把不常用的操作收起来，复用应用共用的下拉菜单。
 */
import {
  ContextMenu,
  type ContextMenuEntry,
} from "../../../shared/ui/ContextMenu.tsx";
import { EllipsisIcon } from "../../../shared/ui/icons.tsx";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import { iconButton } from "./buttons.ts";

export function MoreMenu({
  label = "更多",
  entries,
  triggerRef,
}: {
  label?: string;
  entries: readonly ContextMenuEntry[];
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const { menu, open, dismiss } = useMenuController();
  if (entries.length === 0) return null;
  return (
    <>
      <IconButton
        ref={triggerRef}
        iconSize="compact"
        type="button"
        className={`${iconButton} workflow-more`}
        aria-label={label}
        data-hint={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null && !menu.closing}
        onClick={(event) => {
          if (menu && !menu.closing) {
            dismiss();
            return;
          }
          open(label, label, entries, { trigger: event.currentTarget });
        }}
      >
        <EllipsisIcon className="ui-icon-14" />
      </IconButton>
      {menu && (
        <ContextMenu
          entries={entries}
          placement={menu.placement}
          trigger={menu.trigger}
          label={label}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
