/**
 * 标签总览浮层（ZCode SidePaneTabOverview.tsx:134-266 形态的 desktop 实现）：
 * 触发钮（⌄）+ 搜索行 + 「打开的标签页 / 最近关闭的标签页」两组列表。
 *
 * - 定位复用 ui/ContextMenu.tsx 的「首帧 hidden 量测 → 夹取视口 → 上下翻转」
 *   等价实现（Radix Popper 碰撞避让的 desktop 手写版）；浮层容器对齐 ZCode
 *   popover.tsx 基元：z-[60] / w-72 / rounded-xl / border-border / shadow-md /
 *   sideOffset 4；入退场沿用既有 100ms context-menu-in-* 动效；
 * - 搜索面与评分用 panelTabModel 的纯函数（sidePaneTabSearch.ts 逐行移植）；
 * - 键盘：↑↓ roving + Enter 激活（原生 button）+ Esc 关闭（照 ContextMenu
 *   handleKeyDown 模式）；Tab 不选中只关闭；
 * - 关闭时清空搜索词（ZCode onOpenChange :137-142 同款）。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PanelTab } from "../../stores/rightPanelStore.ts";
import { ChevronsDownIcon, SearchIcon, XIcon } from "../icons.tsx";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  formatTabRelativeTime,
  normalizeSearchQuery,
  PanelTabIcon,
  panelTabSearchHint,
  panelTabTitle,
  panelTabTypeLabel,
} from "./panelTabModel.tsx";

/** 触发钮统一写法（desktop 无 Button 基元的 ghost icon-md 等价，28px）；
    基色 text-ink 对齐 ZCode ghost 的 text-foreground（100%，非 60% 洗色）。 */
export const GHOST_ICON_MD =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";
/** ghost icon-sm 等价（24px，浮窗操作栏用）。 */
export const GHOST_ICON_SM =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover hover:text-ink";

interface OverviewRow {
  tab: PanelTab;
  title: string;
  timeLabel: string;
  searchFields: ReturnType<typeof buildSearchFields>;
}

function buildRows(
  entries: readonly { tab: PanelTab; closedAt?: number }[],
  currentTime: number,
): OverviewRow[] {
  return entries.map(({ tab, closedAt }) => {
    const title = panelTabTitle(tab);
    return {
      tab,
      title,
      timeLabel: formatTabRelativeTime(closedAt ?? tab.openedAt ?? currentTime),
      searchFields: buildSearchFields(
        title,
        panelTabSearchHint(tab),
        panelTabTypeLabel(tab),
      ),
    };
  });
}

/** 打开组行源：tab 即行。 */
const tabRows = (tabs: readonly PanelTab[]): { tab: PanelTab }[] =>
  tabs.map((tab) => ({ tab }));

export function TabOverviewPopover({
  tabs,
  activeTabId,
  recentlyClosed,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  readonly tabs: readonly PanelTab[];
  readonly activeTabId: string;
  readonly recentlyClosed: readonly { tab: PanelTab; closedAt: number }[];
  readonly onActivateTab: (id: string) => void;
  readonly onCloseTab: (id: string) => void;
  readonly onReopenClosedTab: (id: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  // 首帧 hidden 量测 → 夹取视口 → 上下翻转（ContextMenu 同款两拍定位）
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    side: "bottom" | "top";
  } | null>(null);
  const [measured, setMeasured] = useState(false);

  const queryParts = useMemo(() => normalizeSearchQuery(query), [query]);
  const openRows = useMemo(
    () => buildRows(tabRows(tabs), currentTime),
    [tabs, currentTime],
  );
  const closedRows = useMemo(
    () => buildRows(recentlyClosed, currentTime),
    [recentlyClosed, currentTime],
  );
  const filteredOpen = useMemo(
    () => filterAndRankSearchItems(openRows, queryParts),
    [openRows, queryParts],
  );
  const filteredClosed = useMemo(
    () => filterAndRankSearchItems(closedRows, queryParts),
    [closedRows, queryParts],
  );
  const hasAnyResult =
    filteredOpen.length > 0 || filteredClosed.length > 0;

  const close = (reopenFocus = true): void => {
    setOpen(false);
    setQuery("");
    if (reopenFocus) triggerRef.current?.focus();
  };

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setPos(
      rect
        ? { x: rect.left, y: rect.bottom + 4, side: "bottom" }
        : { x: 8, y: 8, side: "bottom" },
    );
    setMeasured(false);
    setOpen(true);
  };

  // 打开期间：相对时间 60s 刷新（ZCode SidePaneTabOverview :124-132 同款）
  useEffect(() => {
    if (!open) return;
    setCurrentTime(Date.now());
    const interval = window.setInterval(
      () => setCurrentTime(Date.now()),
      60_000,
    );
    return () => window.clearInterval(interval);
  }, [open]);

  // 首帧量测定稿：横向夹进视口（左右 8px），纵向放不下翻转到触发钮上方
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    let x = Math.min(pos.x, window.innerWidth - width - 8);
    x = Math.max(8, x);
    let side = pos.side;
    let y = pos.y;
    if (y + height > window.innerHeight - 8 && height > 0) {
      side = "top";
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      y = (triggerRect?.top ?? pos.y) - height - 4;
    }
    y = Math.max(8, y);
    setPos({ x, y, side });
    setMeasured(true);
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    // 仅开启时量测定稿一次（placement 由 toggle 给定，不随后续渲染复算）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点击外部关闭（触发钮与浮层自身除外）
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) === true ||
        triggerRef.current?.contains(target) === true
      )
        return;
      close(false);
    };
    const handleResize = (): void => close(false);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-overview-row]",
      ) ?? [],
    );
    if (rows.length === 0) return;
    const currentIndex = rows.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      currentIndex === -1
        ? event.key === "ArrowDown"
          ? 0
          : rows.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % rows.length
          : (currentIndex - 1 + rows.length) % rows.length;
    rows[nextIndex]?.focus();
  }

  const rowClasses = (isActive: boolean): string =>
    `mb-0.5 flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui-base last:mb-0 hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:outline-none ${
      isActive ? "bg-selected" : ""
    }`;

  const renderRows = (
    rows: OverviewRow[],
    onOpen: (tab: PanelTab) => void,
    closable: boolean,
  ) =>
    rows.map(({ tab, title, timeLabel }) => {
      const isActive = tab.id === activeTabId;
      return (
        <button
          key={tab.id}
          type="button"
          role="option"
          aria-selected={isActive}
          data-overview-row=""
          title={title}
          className={rowClasses(isActive)}
          onClick={() => onOpen(tab)}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-ink-subtle">
            <PanelTabIcon tab={tab} />
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-ink">
            {title}
          </span>
          <span className="mr-0.5 shrink-0 text-ui-base text-ink-subtle">
            {timeLabel}
          </span>
          {closable && (
            <span
              role="button"
              aria-label={`关闭 ${title}`}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-subtle opacity-70 hover:bg-hover hover:opacity-100"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <XIcon className="size-3" />
            </span>
          )}
        </button>
      );
    });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="tab-overview-trigger"
        aria-label="搜索标签页"
        aria-expanded={open}
        className={GHOST_ICON_MD}
        onClick={toggle}
      >
        <ChevronsDownIcon className="size-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label="搜索标签页"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            data-testid="tab-overview"
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              visibility: measured ? "visible" : "hidden",
            }}
            className={`z-[60] flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-menu p-0 text-ink shadow-md outline-none ${
              pos.side === "top"
                ? "context-menu-in-top"
                : "context-menu-in-bottom"
            }`}
          >
            <div className="border-b border-border p-1">
              <div className="flex h-8 items-center gap-2 px-2">
                <SearchIcon className="size-4 shrink-0 text-ink-subtlest" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索标签页..."
                  className="w-full bg-transparent text-ui-base outline-none placeholder:text-ink-subtlest"
                />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {!hasAnyResult && (
                <div className="border-b border-border p-1 last:border-b-0">
                  <p className="px-2 py-2 text-ui-base font-medium text-ink-subtle">
                    打开的标签页
                  </p>
                  <div className="px-4 py-5 text-ink-subtle">
                    没有找到标签页。
                  </div>
                </div>
              )}
              {filteredOpen.length > 0 && (
                <div className="border-b border-border p-1 last:border-b-0">
                  <p className="px-2 py-2 text-ui-base font-medium text-ink-subtle">
                    打开的标签页
                  </p>
                  {renderRows(
                    filteredOpen,
                    (tab) => {
                      onActivateTab(tab.id);
                      close(false);
                    },
                    true,
                  )}
                </div>
              )}
              {filteredClosed.length > 0 && (
                <div className="border-b border-border p-1 last:border-b-0">
                  <p className="px-2 py-2 text-ui-base font-medium text-ink-subtle">
                    最近关闭的标签页
                  </p>
                  {renderRows(
                    filteredClosed,
                    (tab) => {
                      onReopenClosedTab(tab.id);
                      close(false);
                    },
                    false,
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
