import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { useWorkbenchUiValue } from "./bindings/layoutView.ts";

import type { SidebarFooterProps } from "../types.ts";
import {
  ContextMenu,
  type ContextMenuEntry,
} from "../../../shared/ui/ContextMenu.tsx";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import { SettingsIcon, SparkleIcon } from "../../../shared/ui/icons.tsx";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";

export function SidebarFooter({ badge, menuEntries }: SidebarFooterProps) {
  const toggleOverlay = useWorkbenchUiValue((state) => state.toggleOverlay);
  const { menu, open, dismiss } = useMenuController();

  function toggleFooterMenu(trigger: HTMLButtonElement): void {
    if (menu !== null && !menu.closing) {
      dismiss();
      return;
    }
    const entries: readonly ContextMenuEntry[] = [
      {
        // 诊断已并入设置页「诊断」页签（原菜单诊断项移除），设置打开后
        // 可直接切到该页签
        id: "settings",
        label: "设置",
        icon: <SettingsIcon className="ui-icon-16" />,
        onSelect: () => {
          toggleOverlay("settings");
        },
      },
      ...(menuEntries ?? []),
    ];
    open("account", "账号菜单", entries, {
      trigger,
      side: "top",
      align: "start",
    });
  }

  return (
    <>
      <IconButton
        iconSize="rail"
        type="button"
        aria-label="打开账号菜单"
        aria-description={badge?.tooltip}
        aria-haspopup="menu"
        aria-expanded={menu !== null && !menu.closing}
        data-hint={badge?.tooltip ?? "打开账号菜单"}
        onClick={(event) => {
          toggleFooterMenu(event.currentTarget);
        }}
        className={`grid shrink-0 place-items-center rounded-control transition-colors hover:bg-hover focus-visible:ring-inset ${focusVisibleRing}`}
      >
        <span
          aria-hidden="true"
          className={`grid size-7 place-items-center overflow-hidden rounded-pill ${badge ? "sidebar-account-avatar" : "bg-base text-ink"}`}
        >
          {!badge ? (
            <SparkleIcon className="ui-icon-16" />
          ) : (
            <span className="text-ui-sm font-semibold">{badge.avatar}</span>
          )}
        </span>
      </IconButton>
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          trigger={menu.trigger}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

export default SidebarFooter;
