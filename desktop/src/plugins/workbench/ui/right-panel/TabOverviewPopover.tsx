import { composerFieldClass } from "../../../../shared/ui/inputStyles.ts";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../../shared/ui/NavigationRow.tsx";
import { focusVisibleRing } from "../../../../shared/ui/controls.tsx";
import type { PanelTab } from "../../layout/types.ts";
import type { PanelTabPresentation, WorkbenchSnapshot } from "../../types.ts";
/**
 * 标签总览浮层（ZCode SidePaneTabOverview.tsx:134-266 形态的 desktop 实现）：
 * 触发钮（⌄）+ 搜索行 + 「打开的标签页 / 最近关闭的标签页」两组列表。
 *
 * - 定位复用 ui/ContextMenu.tsx 的「首帧 hidden 量测 → 夹取视口 → 上下翻转」
 *   等价实现（Radix Popper 碰撞避让的 desktop 手写版）；浮层容器对齐 ZCode
 *   popover.tsx 基元：z-[60] / w-72 / rounded-xl / border-border / shadow-floating /
 *   sideOffset 4；入退场沿用既有 100ms context-menu-in-* 动效；
 * - 搜索面与评分用 panelTabModel 的纯函数（sidePaneTabSearch.ts 逐行移植）；
 * - 方向键浏览结果，Tab 可访问搜索框、结果和关闭按钮，Esc 归还焦点。
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
import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import {
  ChevronsDownIcon,
  SearchIcon,
  XIcon,
} from "../../../../shared/ui/icons.tsx";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  formatTabRelativeTime,
  normalizeSearchQuery,
  PanelTabIcon,
  panelTabPresentation,
} from "./panelTabModel.tsx";

/** 触发钮统一写法（desktop 无 Button 基元的 ghost icon-md 等价，28px）；
    基色 text-ink 对齐 ZCode ghost 的 text-foreground（100%，非 60% 洗色）。 */
export const GHOST_ICON_MD =
  "flex shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";
/** ghost icon-sm 等价（24px，浮窗操作栏用）。 */
export const GHOST_ICON_SM =
  "flex shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover hover:text-ink";

interface OverviewRow {
  tab: PanelTab;
  presentation: PanelTabPresentation;
  title: string;
  timeLabel: string;
  searchFields: ReturnType<typeof buildSearchFields>;
}

function buildRows(
  entries: readonly { tab: PanelTab; closedAt?: number }[],
  currentTime: number,
  contributions: WorkbenchSnapshot["panels"],
): OverviewRow[] {
  return entries.map(({ tab, closedAt }) => {
    const presentation = panelTabPresentation(tab, contributions);
    const { title, searchHint, typeLabel } = presentation;
    return {
      tab,
      presentation,
      title,
      timeLabel: formatTabRelativeTime(closedAt ?? tab.openedAt ?? currentTime),
      searchFields: buildSearchFields(title, searchHint ?? "", typeLabel ?? ""),
    };
  });
}

/** 打开组行源：tab 即行。 */
const tabRows = (tabs: readonly PanelTab[]): { tab: PanelTab }[] =>
  tabs.map((tab) => ({ tab }));

export function TabOverviewPopover({
  contributions,
  tabs,
  activeTabId,
  recentlyClosed,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  readonly contributions: WorkbenchSnapshot["panels"];
  readonly tabs: readonly PanelTab[];
  readonly activeTabId: string;
  readonly recentlyClosed: readonly { tab: PanelTab; closedAt: number }[];
  readonly onActivateTab: (id: string) => void;
  readonly onCloseTab: (id: string) => void;
  readonly onReopenClosedTab: (id: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  // 首帧 hidden 量测 → 夹取视口 → 上下翻转（ContextMenu 同款两拍定位）
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    maxHeight: number;
  } | null>(null);
  const measured = pos !== null;

  const queryParts = useMemo(() => normalizeSearchQuery(query), [query]);
  const openRows = useMemo(
    () => buildRows(tabRows(tabs), currentTime, contributions),
    [tabs, currentTime, contributions],
  );
  const closedRows = useMemo(
    () => buildRows(recentlyClosed, currentTime, contributions),
    [recentlyClosed, currentTime, contributions],
  );
  const filteredOpen = useMemo(
    () => filterAndRankSearchItems(openRows, queryParts),
    [openRows, queryParts],
  );
  const filteredClosed = useMemo(
    () => filterAndRankSearchItems(closedRows, queryParts),
    [closedRows, queryParts],
  );
  const hasAnyResult = filteredOpen.length > 0 || filteredClosed.length > 0;

  // 仅收起浮层并清搜索词：不触达 ref，渲染期创建的行回调可安全引用
  const dismiss = (): void => {
    setOpen(false);
    setQuery("");
    setPos(null);
  };
  const close = (reopenFocus = true): void => {
    dismiss();
    if (reopenFocus) triggerRef.current?.focus();
  };

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    setCurrentTime(Date.now());
    setOpen(true);
  };

  // 打开期间：相对时间 60s 刷新（ZCode SidePaneTabOverview :124-132 同款）；
  // 打开瞬间的刷新在 toggle 里做，effect 里同步 setState 会被禁
  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(
      () => setCurrentTime(Date.now()),
      60_000,
    );
    return () => window.clearInterval(interval);
  }, [open]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel || !trigger) return;
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const below = Math.max(0, window.innerHeight - anchor.bottom - 12);
      const above = Math.max(0, anchor.top - 12);
      const useBelow = height <= below || below >= above;
      const maxHeight = useBelow ? below : above;
      const x = Math.max(
        8,
        Math.min(anchor.left, window.innerWidth - width - 8),
      );
      const y = Math.max(
        8,
        useBelow
          ? anchor.bottom + 4
          : anchor.top - Math.min(height, maxHeight) - 4,
      );
      setPos((previous) =>
        previous?.x === x &&
        previous.y === y &&
        previous.maxHeight === maxHeight
          ? previous
          : { x, y, maxHeight },
      );
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(place);
    observer?.observe(panel);
    observer?.observe(trigger);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (measured) searchRef.current?.focus();
  }, [measured]);

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
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resultButtons = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-overview-row]",
      ) ?? [],
    );
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      const controls =
        event.currentTarget.querySelectorAll<HTMLElement>("input, button");
      const boundary = event.shiftKey
        ? controls[0]
        : controls[controls.length - 1];
      if (event.target === boundary) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = resultButtons();
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

  const renderRows = (
    rows: OverviewRow[],
    onOpen: (id: string) => void,
    closable: boolean,
  ) =>
    rows.map(({ tab, presentation, title, timeLabel }) => {
      const isActive = tab.id === activeTabId;
      return (
        <div
          key={tab.id}
          className={`mb-0.5 flex items-center rounded-md px-2 last:mb-0 ${isActive ? "bg-selected" : "hover:bg-menu-hover"}`}
        >
          <NavigationRow
            layout="compound"
            aria-current={isActive ? "page" : undefined}
            data-overview-row=""
            data-hint={title}
            className="min-h-8 cursor-pointer items-center gap-2"
            onClick={() => {
              onOpen(tab.id);
              close();
            }}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-ink-subtle">
              <PanelTabIcon presentation={presentation} />
            </span>
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-ink">
              {title}
            </span>
            <span className="mr-0.5 shrink-0 text-ui-base text-ink-subtle">
              {timeLabel}
            </span>
          </NavigationRow>
          {closable && (
            <IconButton
              iconSize="compact"
              aria-label={`关闭 ${title}`}
              className={`flex shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-subtle opacity-70 hover:bg-hover hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset ${focusVisibleRing}`}
              onClick={(event) => {
                if (event.detail === 0) {
                  const row =
                    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                      "[data-overview-row]",
                    );
                  const rows = resultButtons();
                  const index = row ? rows.indexOf(row) : -1;
                  (
                    rows[index + 1] ??
                    rows[index - 1] ??
                    searchRef.current
                  )?.focus();
                }
                onCloseTab(tab.id);
              }}
            >
              <XIcon className="ui-icon-12" />
            </IconButton>
          )}
        </div>
      );
    });

  return (
    <>
      <IconButton
        ref={triggerRef}
        type="button"
        data-testid="tab-overview-trigger"
        aria-label="搜索标签页"
        aria-expanded={open}
        className={`${GHOST_ICON_MD} focus-visible:ring-inset ${focusVisibleRing}`}
        onClick={toggle}
      >
        <ChevronsDownIcon className="ui-icon-16" />
      </IconButton>
      {createPortal(
        <HintSurface
          open={open}
          ref={panelRef}
          role="dialog"
          aria-label="搜索标签页"
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          data-testid="tab-overview"
          style={{
            position: "fixed",
            left: pos?.x ?? 0,
            top: pos?.y ?? 0,
            maxHeight: pos?.maxHeight,
            visibility: measured ? "visible" : "hidden",
          }}
          className="z-[60] flex w-[min(18rem,calc(100vw-16px))] flex-col overflow-hidden p-0 outline-none"
        >
          <div className="shrink-0 border-b border-border p-1">
            <div className="flex h-8 items-center gap-2 px-2">
              <SearchIcon className="ui-icon-16 shrink-0 text-ink-subtlest" />
              <input
                ref={searchRef}
                aria-label="查找标签页"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标签页..."
                className={`${composerFieldClass} w-full`}
              />
            </div>
          </div>
          <div className="min-h-0 max-h-80 overflow-y-auto">
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
                {renderRows(filteredOpen, onActivateTab, true)}
              </div>
            )}
            {filteredClosed.length > 0 && (
              <div className="border-b border-border p-1 last:border-b-0">
                <p className="px-2 py-2 text-ui-base font-medium text-ink-subtle">
                  最近关闭的标签页
                </p>
                {renderRows(filteredClosed, onReopenClosedTab, false)}
              </div>
            )}
          </div>
        </HintSurface>,
        document.body,
      )}
    </>
  );
}
