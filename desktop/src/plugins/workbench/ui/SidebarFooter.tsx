import { useWorkbenchUiValue } from "./bindings/layoutView.ts";
import { useEffect, useRef, useState } from "react";

import type { SidebarFooterProps } from "../types.ts";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../../../shared/ui/ContextMenu.tsx";
import { SettingsIcon, SparkleIcon } from "../../../shared/ui/icons.tsx";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

interface FooterMenuState {
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly closing: boolean;
}

export function SidebarFooter({ badge, menuEntries }: SidebarFooterProps) {
  const toggleOverlay = useWorkbenchUiValue((state) => state.toggleOverlay);
  const [menu, setMenu] = useState<FooterMenuState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // 两拍关闭（与 ProjectTree 的单例菜单同款）：onDismiss 置 closing 播
  // 退场，100ms 后卸载（jsdom 无动画也能收口）
  const dismiss = (): void => {
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
  };

  // 卸载时清掉挂起的退场计时器
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  function openFooterMenu(anchor: DOMRect): void {
    // open 即换现场：清掉挂起的退场计时器（closing 态重开不能被旧计时器
    // 误杀，ProjectTree 单例控制器同款）
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
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
    setMenu({
      entries,
      placement: {
        x: anchor.left,
        y: anchor.top - 4,
        side: "top",
        align: "start",
      },
      closing: false,
    });
  }

  // 触发器再点一次收起；closing 态（退场动画中）视作已关，重开
  const toggleFooterMenu = (anchor: DOMRect): void => {
    if (menu !== null && !menu.closing) {
      dismiss();
      return;
    }
    openFooterMenu(anchor);
  };

  return (
    <>
      <button
        type="button"
        aria-label="打开账号菜单"
        aria-description={badge?.tooltip}
        aria-haspopup="menu"
        aria-expanded={menu !== null && !menu.closing}
        data-hint={badge?.tooltip ?? "打开账号菜单"}
        onClick={(event) => {
          toggleFooterMenu(event.currentTarget.getBoundingClientRect());
        }}
        className={`grid min-h-9 min-w-9 shrink-0 place-items-center rounded-lg transition-colors hover:bg-hover ${focusVisibleRing}`}
      >
        <span aria-hidden="true" className="grid size-7 place-items-center overflow-hidden rounded-full bg-base text-ink">
          {!badge ? (
            <SparkleIcon className="ui-icon-16" />
          ) : (
            <span className="text-ui-sm font-semibold">
              {badge.avatar}
            </span>
          )}
        </span>
      </button>
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label="账号菜单"
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

export default SidebarFooter;
