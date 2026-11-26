/**
 * 侧栏右键/下拉菜单（ZCode 菜单语言的 desktop 实现）：
 *
 * - 容器对照 ZCode ContextMenuContent（components/ui/context-menu.tsx:28）：
 *   z-[60]（必须高于仅提供说明的 tooltip，同注释）、rounded-popover、
 *   border-border、bg-menu、p-1、gap-0.5、shadow-floating、100ms 入退场；
 * - 菜单项对照 ContextMenuItem（:52）：min-h-7 rounded-control px-2 py-1 gap-2，
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
 * - 子菜单独立 portal，沿用父菜单样式与碰撞避让；整棵菜单统一关闭，
 *   左右方向键切换层级，Esc 逐层返回。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { CheckIcon, ChevronRightIcon } from "./icons.tsx";
import { PageFilterSearch } from "./PageFilterControls.tsx";

export interface ContextMenuItemSpec {
  id: string;
  label: string;
  description?: string;
  /** 菜单项图标以 ui-icon-16 为基准。 */
  icon?: ReactNode;
  /** 备用；desktop 暂无来源。 */
  shortcut?: string;
  danger?: boolean;
  warning?: boolean;
  disabled?: boolean;
  /** 视角切换等单选语义（role=menuitemradio + aria-checked）。 */
  radio?: boolean;
  selected?: boolean;
  checked?: boolean;
  onSelect: () => void;
  children?: never;
}

export interface ContextMenuSubmenuSpec extends Omit<
  ContextMenuItemSpec,
  "onSelect" | "children"
> {
  children: readonly ContextMenuEntry[];
  onSelect?: never;
}

export type ContextMenuEntry =
  ContextMenuItemSpec | ContextMenuSubmenuSpec | { type: "separator" };

interface MenuTree {
  panels: Set<HTMLDivElement>;
  dismiss: () => void;
}

export interface ContextMenuSearch {
  readonly label: string;
  readonly emptyLabel: string;
  readonly noMatchesLabel: string;
  readonly action?: ReactNode;
}

export interface MenuPlacement {
  x: number;
  y: number;
  side: "bottom" | "top" | "right" | "left";
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
      "button:is([role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']):not([disabled])",
    ),
  );
}

export function ContextMenu({
  entries,
  placement,
  label,
  closing,
  onDismiss,
  portalContainer = document.body,
  trigger,
  variant = "menu",
  header,
  search,
  parentTree,
  id,
}: {
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  /** 菜单面板的可访问名称（aria-label）。 */
  readonly label: string;
  /** 退场中：换播 100ms 退场动画，宿主随后卸载。 */
  readonly closing: boolean;
  readonly onDismiss: () => void;
  readonly portalContainer?: HTMLElement;
  readonly trigger?: HTMLElement;
  readonly variant?: "menu" | "selection";
  readonly header?: ReactNode;
  readonly search?: ContextMenuSearch;
  /** 仅供递归子菜单共享浮层边界与根关闭入口。 */
  readonly parentTree?: MenuTree;
  readonly id?: string;
}) {
  const isSelection = variant === "selection";
  const isSearchable = search !== undefined;
  const hasHeader = Boolean(header || search);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [ownTree] = useState<MenuTree>(() => ({
    panels: new Set(),
    dismiss: onDismiss,
  }));
  const tree = parentTree ?? ownTree;
  const submenuId = useId();
  const [expanded, setExpanded] = useState<{
    id: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const submenu = entries.find(
    (entry) => !("type" in entry) && entry.id === expanded?.id,
  );
  useLayoutEffect(() => {
    if (!parentTree) tree.dismiss = onDismiss;
    const panel = panelRef.current;
    if (!panel) return;
    tree.panels.add(panel);
    return () => {
      tree.panels.delete(panel);
    };
  }, [onDismiss, parentTree, tree]);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const term = query.trim().toLowerCase();
  const visibleEntries =
    search && term
      ? entries.filter(
          (entry) =>
            !("type" in entry) && entry.label.toLowerCase().includes(term),
        )
      : entries;
  const resultOptions = search
    ? visibleEntries.flatMap((entry, index) =>
        "type" in entry || entry.disabled ? [] : [{ entry, index }],
      )
    : [];
  const highlightedIndex = resultOptions.findIndex(
    ({ entry }) => entry.id === highlightedId,
  );
  const highlighted = resultOptions[highlightedIndex];
  const highlightedDomId = highlighted
    ? `${listId}-${highlighted.index}`
    : undefined;
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
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const updatePosition = () => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const anchor = trigger?.getBoundingClientRect();
      const anchorX =
        (placement.align === "end" ? anchor?.right : anchor?.left) ??
        placement.x;
      // 先按触发器对齐，再夹进视口；空间不足时换到较宽松的一侧。
      const left = placement.align === "end" ? anchorX - width : anchorX;
      let x = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      let side = placement.side;
      let y = placement.y;
      if (anchor && (side === "right" || side === "left")) {
        const parent =
          trigger?.closest('[role="menu"]')?.getBoundingClientRect() ?? anchor;
        const right = parent.right + 4;
        const left = parent.left - width - 4;
        if (
          side === "right" &&
          right + width > window.innerWidth - 8 &&
          left >= 8
        )
          side = "left";
        else if (
          side === "left" &&
          left < 8 &&
          right + width <= window.innerWidth - 8
        )
          side = "right";
        x = Math.max(
          8,
          Math.min(
            side === "left" ? left : right,
            window.innerWidth - width - 8,
          ),
        );
        y = anchor.top;
      } else if (anchor) {
        const top = anchor.top - (isSelection ? 6 : 4);
        const bottom = anchor.bottom + 4;
        const above = top - 8;
        const below = window.innerHeight - bottom - 8;
        if (side === "top" && height > above && below > above) side = "bottom";
        else if (side === "bottom" && height > below && above > below)
          side = "top";
        y = side === "top" ? top - height : bottom;
      } else if (side === "top" || y + height > window.innerHeight - 8) {
        y -= height + (side === "top" ? 0 : 8);
        side = "top";
      }
      y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
      setPos((previous) =>
        previous.x === x && previous.y === y && previous.side === side
          ? previous
          : { x, y, side },
      );
    };
    updatePosition();
    setMeasured(true);
    if (!isSelection && !trigger) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(panel);
    if (trigger) observer?.observe(trigger);
    const repositionAfterScroll = (event: Event) => {
      if (!(event.target instanceof Node && panel.contains(event.target)))
        schedule();
    };
    window.addEventListener("resize", schedule);
    const repositionAfterAnimation = (event: AnimationEvent) => {
      if (
        trigger &&
        event.target instanceof HTMLElement &&
        event.target.contains(trigger)
      )
        schedule();
    };
    window.addEventListener("animationend", repositionAfterAnimation);
    if (trigger) window.addEventListener("scroll", repositionAfterScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("animationend", repositionAfterAnimation);
      window.removeEventListener("scroll", repositionAfterScroll, true);
    };
  }, [isSelection, placement, trigger]);

  useLayoutEffect(() => {
    if (measured && !closing) {
      (isSearchable
        ? searchRef.current
        : parentTree
          ? (focusableItems(panelRef.current)[0] ?? panelRef.current)
          : panelRef.current
      )?.focus({
        preventScroll: true,
      });
    }
  }, [closing, isSearchable, measured, parentTree]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const option =
      highlightedDomId && document.getElementById(highlightedDomId);
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom)
      list.scrollTop += row.bottom - bounds.bottom;
  }, [highlightedDomId]);

  useEffect(() => {
    if (parentTree) return;
    function handlePointerDown(event: PointerEvent): void {
      if (
        event.target instanceof Node &&
        ([...tree.panels].some((panel) =>
          panel.contains(event.target as Node),
        ) ||
          trigger?.contains(event.target))
      ) {
        return;
      }
      onDismiss();
    }
    function handleDismiss(): void {
      onDismiss();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    if (!trigger) window.addEventListener("resize", handleDismiss);
    if (!isSelection && !trigger)
      window.addEventListener("blur", handleDismiss);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [isSelection, onDismiss, parentTree, tree, trigger]);

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
    if (event.nativeEvent.isComposing) return;
    // 子菜单的键盘事件不能穿过 portal 再交给父层处理。
    if (parentTree) event.stopPropagation();
    if (event.key === "Escape") {
      // 标记 Esc 已被浮层消费（SessionView 全局 Esc 的既有让位约定）
      event.preventDefault();
      if (expanded) closeSubmenu();
      else onDismiss();
      return;
    }
    if (event.key === "Tab") {
      if (
        search?.action &&
        event.target === searchRef.current &&
        !event.shiftKey
      )
        return;
      if (search && event.target !== searchRef.current && event.shiftKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Tab 不选中，只关闭（ZCode Menu 的 roving 循环不外溢）
      event.preventDefault();
      tree.dismiss();
      return;
    }
    if (event.key === "ArrowLeft" && parentTree) {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (search) {
      if (event.key === "Enter" && event.target === searchRef.current) {
        event.preventDefault();
        if (highlighted) {
          const button =
            highlightedDomId && document.getElementById(highlightedDomId);
          if (button instanceof HTMLButtonElement)
            selectEntry(highlighted.entry, button);
        }
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!resultOptions.length) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next =
          highlightedIndex < 0
            ? delta === 1
              ? 0
              : resultOptions.length - 1
            : (highlightedIndex + delta + resultOptions.length) %
              resultOptions.length;
        setHighlightedId(resultOptions[next]!.entry.id);
        searchRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "ArrowRight") {
      const button = document.activeElement;
      const entry = entries.find(
        (entry) =>
          !("type" in entry) &&
          entry.id ===
            (button instanceof HTMLElement
              ? button.dataset.menuItem
              : undefined),
      );
      if (
        entry &&
        !("type" in entry) &&
        entry.children &&
        button instanceof HTMLButtonElement
      ) {
        event.preventDefault();
        setExpanded({ id: entry.id, trigger: button });
      }
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
    setExpanded(null);
    items[nextIndex]?.focus();
  }

  function closeSubmenu() {
    expanded?.trigger.focus({ preventScroll: true });
    setExpanded(null);
  }

  function selectEntry(
    entry: ContextMenuItemSpec | ContextMenuSubmenuSpec,
    button: HTMLButtonElement,
  ) {
    if (entry.children) {
      setExpanded(
        expanded?.id === entry.id ? null : { id: entry.id, trigger: button },
      );
      return;
    }
    entry.onSelect();
    tree.dismiss();
  }

  const renderedEntries = visibleEntries.map((entry, index) =>
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
        id={search ? `${listId}-${index}` : undefined}
        role={
          search
            ? "option"
            : entry.checked !== undefined
              ? "menuitemcheckbox"
              : entry.radio
                ? "menuitemradio"
                : "menuitem"
        }
        aria-checked={
          search
            ? undefined
            : (entry.checked ?? (entry.radio ? entry.selected : undefined))
        }
        aria-selected={search ? Boolean(entry.selected) : undefined}
        data-search-active={
          search && entry.id === highlighted?.entry.id ? "true" : undefined
        }
        aria-label={entry.description ? entry.label : undefined}
        aria-description={entry.description}
        data-menu-item={entry.id}
        aria-haspopup={entry.children ? "menu" : undefined}
        aria-expanded={entry.children ? expanded?.id === entry.id : undefined}
        aria-controls={
          entry.children && expanded?.id === entry.id ? submenuId : undefined
        }
        tabIndex={isSelection || isSearchable ? -1 : undefined}
        disabled={entry.disabled}
        onFocus={() => {
          if (expanded && expanded.id !== entry.id) setExpanded(null);
        }}
        onClick={(event) => selectEntry(entry, event.currentTarget)}
        className={`relative flex min-h-7 w-full shrink-0 cursor-default items-center gap-2 rounded-control text-left text-ui-base/relaxed text-ink outline-none select-none hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:text-ink disabled:pointer-events-none disabled:text-ink-subtlest [&_svg]:pointer-events-none [&_svg]:ui-icon-16 [&_svg]:shrink-0 ${
          // radio 行对照 ZCode DropdownMenuRadioItem（dropdown-menu.tsx:149）：
          // py-1.5 pr-8 pl-2，右侧留出指示位；普通项维持 ContextMenuItem 的 px-2 py-1
          entry.radio || entry.checked !== undefined
            ? "py-1.5 pr-8 pl-2"
            : "px-2 py-1"
        } ${
          entry.danger
            ? // destructive 对照 ZCode data-[variant=destructive]（context-menu.tsx:52）：
              // 常态实字色，实底高亮 + 白字（text-destructive-foreground 同值）
              "text-danger hover:bg-danger hover:text-danger-contrast focus-visible:bg-danger focus-visible:text-danger-contrast"
            : entry.warning
              ? "text-warn-ink"
              : ""
        } ${isSelection ? "min-h-8 items-start focus-visible:keyboard-focus-marker" : ""} ${search ? "data-[search-active=true]:bg-menu-hover data-[search-active=true]:keyboard-focus-marker" : ""}`}
      >
        {entry.icon}
        {entry.description ? (
          <span className="min-w-0 flex-1 break-words">
            <span className="block">{entry.label}</span>
            <span className="mt-0.5 block text-ui-sm leading-snug text-ink-soft">
              {entry.description}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {entry.label}
          </span>
        )}
        {entry.shortcut !== undefined ? (
          <span className="ml-auto text-ui-xs tracking-widest text-ink-subtlest">
            {entry.shortcut}
          </span>
        ) : null}
        {entry.children ? (
          <ChevronRightIcon className="ml-auto ui-icon-16 text-ink-subtle" />
        ) : null}
        {entry.radio || entry.checked !== undefined ? (
          // 选中指示：绝对定位右缘的 CheckIcon（ZCode RadioItem
          // indicator span right-2 + CheckIcon size-4 text-foreground-subtle）
          <span
            aria-hidden={true}
            className="pointer-events-none absolute right-2 flex items-center justify-center"
          >
            {(entry.checked ?? entry.selected) ? (
              <CheckIcon className="ui-icon-16 text-ink-subtle" />
            ) : null}
          </span>
        ) : null}
      </button>
    ),
  );

  return (
    <>
      {createPortal(
        <div
          ref={panelRef}
          id={id}
          role={search ? "dialog" : "menu"}
          aria-label={label}
          aria-hidden={closing || undefined}
          inert={closing}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          style={{
            position: "fixed",
            left: pos.x,
            top: pos.y,
            visibility: measured ? "visible" : "hidden",
          }}
          className={`z-[60] flex min-w-[min(11rem,calc(100vw-1rem))] ${parentTree ? "max-w-[min(24rem,calc(100vw-1rem))]" : "max-w-[calc(100vw-1rem)]"} flex-col gap-0.5 overscroll-contain rounded-popover border border-border bg-menu p-1 text-ink shadow-floating outline-none ${
            hasHeader ? "overflow-hidden" : "overflow-y-auto"
          } ${
            isSelection
              ? "w-64 max-h-[min(13rem,calc(100dvh-1rem))]"
              : "max-h-[calc(100dvh-1rem)]"
          } ${
            closing
              ? "context-menu-out"
              : isSelection
                ? "selection-popup"
                : pos.side === "top"
                  ? "context-menu-in-top"
                  : "context-menu-in-bottom"
          }`}
        >
          {hasHeader && (
            <div className="shrink-0 border-b border-border">
              {search && (
                <div className="flex items-center gap-1 p-1">
                  <PageFilterSearch
                    label={search.label}
                    placeholder={`${search.label}…`}
                    value={query}
                    onChange={(value) => {
                      setQuery(value);
                      setHighlightedId(null);
                      if (listRef.current) listRef.current.scrollTop = 0;
                    }}
                    className="flex-1"
                    compact
                    inputProps={{
                      ref: searchRef,
                      role: "combobox",
                      "aria-autocomplete": "list",
                      "aria-expanded": true,
                      "aria-controls": listId,
                      "aria-activedescendant": highlightedDomId,
                    }}
                  />
                  {search.action}
                </div>
              )}
              {header}
            </div>
          )}
          {hasHeader ? (
            <div
              className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
              ref={search ? listRef : undefined}
              id={search ? listId : undefined}
              role={search ? "listbox" : undefined}
              aria-label={search ? label : undefined}
            >
              {renderedEntries}
            </div>
          ) : (
            renderedEntries
          )}
          {search && visibleEntries.length === 0 && (
            <p role="status" className="px-2 py-2 text-ui-sm text-ink-mute">
              {entries.length ? search.noMatchesLabel : search.emptyLabel}
            </p>
          )}
        </div>,
        portalContainer,
      )}{" "}
      {expanded && submenu && !("type" in submenu) && submenu.children ? (
        <ContextMenu
          id={submenuId}
          entries={submenu.children}
          placement={{ x: 0, y: 0, side: "right" }}
          label={submenu.label}
          closing={closing}
          onDismiss={closeSubmenu}
          portalContainer={portalContainer}
          trigger={expanded.trigger}
          parentTree={tree}
        />
      ) : null}
    </>
  );
}
