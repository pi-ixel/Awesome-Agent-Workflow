/**
 * 侧栏底部 footer（ZCode WorkspaceSidebarFooter.tsx:232-493 同位同形态）：
 * 左侧「身份区 + 统一设置菜单入口」（头像位 + 用户名位，点击弹设置菜单），
 * 右侧设置齿轮直入设置页。
 *
 * desktop 无账号体系（无登录 / 头像 URL），身份区降级为静态 AAW 标识：
 * 32px 圆形 fallback（ZCode Avatar size default=size-8，fallback
 * bg-background text-foreground → desktop bg-base text-ink）+ 用户名位
 * （text-ui-base font-semibold，ZCode footer :182 同档）。菜单只含
 * 「设置 / 诊断」两项——原图标窄栏底部的两个入口原样迁入（toggleOverlay
 * 再点同页取消的语义不变）；ZCode 菜单里的语言 / 主题 / 缩放 / 用量 /
 * 登录登出在 desktop 无对应能力，不渲染。
 *
 * ZCode footer 复用于 Settings 页的形态不适用：desktop 设置页为全屏
 * 覆盖层，自带「← 返回」条。
 */
import { useEffect, useRef, useState } from "react";

import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../ContextMenu.tsx";
import { SettingsIcon, SparkleIcon } from "../icons.tsx";

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

interface FooterMenuState {
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly closing: boolean;
}

export function SidebarFooter() {
  const toggleOverlay = useWorkbenchUiStore((state) => state.toggleOverlay);
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
    const entries: ContextMenuEntry[] = [
      {
        // 诊断已并入设置页「诊断」页签（原菜单诊断项移除），设置打开后
        // 可直接切到该页签
        id: "settings",
        label: "设置",
        icon: <SettingsIcon className="h-4 w-4" />,
        onSelect: () => {
          toggleOverlay("settings");
        },
      },
    ];
    setMenu({
      entries,
      // ZCode DropdownMenuContent align="start"：菜单左缘对齐触发器左缘
      placement: {
        x: anchor.left,
        y: anchor.bottom + 4,
        side: "bottom",
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
    <footer className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-4">
      {/* 左：身份 + 统一设置菜单入口（ZCode footer :238-252 ghost size
          lg=h-8 rounded-lg pl-0） */}
      <button
        type="button"
        aria-label="打开设置菜单"
        aria-haspopup="menu"
        aria-expanded={menu !== null && !menu.closing}
        title="打开设置菜单"
        onClick={(event) => {
          toggleFooterMenu(event.currentTarget.getBoundingClientRect());
        }}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl pl-0 text-left transition-colors hover:bg-hover"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-base text-ink">
          <SparkleIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate text-ui-base font-semibold text-ink">
          AAW
        </span>
      </button>
      {/* 右：设置齿轮（ZCode footer :478-490 ghost icon-lg=size-8
          rounded-lg + Settings size-4） */}
      <button
        type="button"
        data-testid="task-settings-button"
        aria-label="设置"
        title="设置"
        onClick={() => {
          toggleOverlay("settings");
        }}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink"
      >
        <SettingsIcon className="h-4 w-4" />
      </button>
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label="设置菜单"
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </footer>
  );
}

export default SidebarFooter;
