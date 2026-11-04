/**
 * 侧栏右键/下拉菜单（ZCode 菜单语言的 desktop 实现）：
 *
 * - 容器对照 ZCode ContextMenuContent（components/ui/context-menu.tsx:28）：
 *   z-[60]（必须高于仅提供说明的 tooltip，同注释）、min-w-44、rounded-lg、
 *   border-border、bg-menu、p-1、gap-0.5、shadow-md、100ms 入退场；
 * - 菜单项对照 ContextMenuItem（:52）：min-h-7 rounded-md px-2 py-1 gap-2，
 *   Radix 的 data-[highlighted] 高亮由 hover + focus-visible（roving focus）
 *   承担；destructive 对照 :52 的 data-[variant=destructive] 配方——常态
 *   text-danger，实底 hover/focus bg-danger + text-danger-contrast
 *   （desktop token 与 ZCode --color-destructive[-foreground] 同值）；
 *   radio 行对照 DropdownMenuRadioItem（dropdown-menu.tsx:149）：py-1.5
 *   pr-8 pl-2，选中指示为绝对定位 right-2 的 CheckIcon size-4
 *   text-ink-subtle；分隔线 bg-border（styles.css:695 --color-border）；
 * - 定位是 Radix Popper 碰撞避让的等价实现：首帧以 visibility:hidden 渲染
 *   于初始坐标，量得实际宽高后夹取视口（左右 8px 边距），side=bottom 放不
 *   下时翻转到锚点上方；
 * - 关闭走两拍：onDismiss 只置 closing（播 100ms 退场动画），宿主在
 *   100ms 后卸载（setTimeout 主路径，jsdom 无动画也能收口）；
 * - 子菜单（SubTrigger/SubContent，context-menu.tsx:77-115）不实现：侧栏
 *   菜单全为平面，待有分组/颜色能力时按 ZCode 形态补（SubContent=min-w-32，
 *   SubTrigger 尾 ChevronRightIcon ml-auto size-4 text-foreground-subtle）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { CheckIcon } from "./icons.tsx";

export interface ContextMenuItemSpec {
  id: string;
  label: string;
  /** 统一由 [&_svg]:size-4 收口（ZCode [&_svg:not([class*='size-'])]:size-4）。 */
  icon?: ReactNode;
  /** 备用；desktop 暂无来源。 */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 视角切换等单选语义（role=menuitemradio + aria-checked）。 */
  radio?: boolean;
  selected?: boolean;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuItemSpec | { type: "separator" };

export interface MenuPlacement {
  x: number;
  y: number;
  side: "bottom" | "top";
  /**
   * 锚定触发器下拉的水平对齐：end = x 为菜单**右缘**（ZCode
   * ProjectSidebarListHeader 用 DropdownMenuContent align="end"——菜单右缘
   * 对齐触发器右缘），start（缺省）= x 即菜单左缘（指针右键的 clientX）。
   */
  align?: "start" | "end";
}

/** 可聚焦的菜单项（disabled 不参与 roving）。 */
function focusableItems(panel: HTMLDivElement | null): HTMLButtonElement[] {
  if (panel === null) {
    return [];
  }
  return Array.from(
    panel.querySelectorAll<HTMLButtonElement>(
      "button[role='menuitem']:not([disabled]), button[role='menuitemradio']:not([disabled])",
    ),
  );
}

export function ContextMenu({
  entries,
  placement,
  label,
  closing,
  onDismiss,
}: {
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  /** 菜单面板的可访问名称（aria-label）。 */
  readonly label: string;
  /** 退场中：换播 100ms 退场动画，宿主随后卸载。 */
  readonly closing: boolean;
  readonly onDismiss: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 首帧以 visibility:hidden 渲染于初始坐标，量得实际宽高后再定稿
  const [pos, setPos] = useState<{ x: number; y: number; side: string }>(
    () => ({
      x: placement.x,
      y: placement.y,
      side: placement.side,
    }),
  );
  const [measured, setMeasured] = useState(false);
  // 开启前的焦点元素：最终关闭（卸载）时归还
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const rect = panelRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    // 横向：右对齐先折算左缘，再夹进视口（左右各留 8px）
    let x = placement.align === "end" ? placement.x - width : placement.x;
    x = Math.min(x, window.innerWidth - width - 8);
    x = Math.max(8, x);
    // 纵向：side=bottom 放不下（含 8px 边距）翻转到锚点上方；y 为底缘
    let side = placement.side;
    let y = placement.y;
    if (side === "top") {
      y = placement.y - height;
    } else if (y + height > window.innerHeight - 8) {
      side = "top";
      y = placement.y - height - 8;
    }
    y = Math.max(8, y);
    setPos({ x, y, side });
    setMeasured(true);
    // 仅开启时量测定稿一次（placement 由宿主在开启时给定，不随后续渲染复算）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      if (panelRef.current?.contains(event.target as Node) === true) {
        return;
      }
      onDismiss();
    }
    function handleDismiss(): void {
      onDismiss();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("blur", handleDismiss);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [onDismiss]);

  // 最终关闭（卸载）时把焦点归还给开启前的元素；但期间已有别处接手焦点
  // 时让位（如菜单项触发「重命名」输入框 autoFocus 后，归还反而夺焦，
  // 触发 SessionBar 的 onBlur 立即退出编辑态）
  useEffect(() => {
    return () => {
      const previous = restoreFocusRef.current;
      if (previous === null || !previous.isConnected) {
        return;
      }
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        return;
      }
      previous.focus();
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      // 标记 Esc 已被浮层消费（SessionView 全局 Esc 的既有让位约定）
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === "Tab") {
      // Tab 不选中，只关闭（ZCode Menu 的 roving 循环不外溢）
      event.preventDefault();
      onDismiss();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const items = focusableItems(panelRef.current);
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (currentIndex === -1) {
      // 焦点还在面板上：Down 落首项，Up 落末项
      nextIndex = event.key === "ArrowDown" ? 0 : items.length - 1;
    } else if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % items.length;
    } else {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    }
    items[nextIndex]?.focus();
  }

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        visibility: measured ? "visible" : "hidden",
      }}
      className={`z-[60] flex min-w-44 flex-col gap-0.5 overflow-hidden rounded-lg border border-border bg-menu p-1 text-ink shadow-md outline-none ${
        closing
          ? "context-menu-out"
          : pos.side === "top"
            ? "context-menu-in-top"
            : "context-menu-in-bottom"
      }`}
    >
      {entries.map((entry, index) =>
        "type" in entry ? (
          <div
            key={`separator-${index}`}
            role="separator"
            className="-mx-1 my-1 h-px bg-border"
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            role={entry.radio ? "menuitemradio" : "menuitem"}
            aria-checked={entry.radio ? entry.selected : undefined}
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect();
              onDismiss();
            }}
            className={`relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md text-left text-ui-base/relaxed text-ink outline-none select-none hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:text-ink disabled:pointer-events-none disabled:text-ink-subtlest [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${
              // radio 行对照 ZCode DropdownMenuRadioItem（dropdown-menu.tsx:149）：
              // py-1.5 pr-8 pl-2，右侧留出指示位；普通项维持 ContextMenuItem 的 px-2 py-1
              entry.radio ? "py-1.5 pr-8 pl-2" : "px-2 py-1"
            } ${
              entry.danger
                ? // destructive 对照 ZCode data-[variant=destructive]（context-menu.tsx:52）：
                  // 常态实字色，实底高亮 + 白字（text-destructive-foreground 同值）
                  "text-danger hover:bg-danger hover:text-danger-contrast focus-visible:bg-danger focus-visible:text-danger-contrast"
                : ""
            }`}
          >
            {entry.icon}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut !== undefined ? (
              <span className="ml-auto text-ui-xs tracking-widest text-ink-subtlest">
                {entry.shortcut}
              </span>
            ) : null}
            {entry.radio ? (
              // 选中指示：绝对定位右缘的 CheckIcon（ZCode RadioItem
              // indicator span right-2 + CheckIcon size-4 text-foreground-subtle）
              <span
                aria-hidden={true}
                className="pointer-events-none absolute right-2 flex items-center justify-center"
              >
                {entry.selected ? (
                  <CheckIcon className="h-4 w-4 text-ink-subtle" />
                ) : null}
              </span>
            ) : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
