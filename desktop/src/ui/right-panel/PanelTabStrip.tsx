/**
 * 右栏 48px 标签条（ZCode AnimatedSidePanePanel.tsx:1026-1147 的 desktop 子集）：
 * 总览切换器（⌄）+ 完整视图对话 tab（仅 fullView 时）+ 可横向滚动的 tab 行
 * （溢出时「+」固定到右簇）+ 右簇（完整视图开关 / 关闭右栏）。
 *
 * - 溢出判定用 panelTabModel.resolveTabsOverflow（sidePaneLayout.ts 逐行移植），
 *   还原「+号在行尾」的假想布局防 ResizeObserver 反馈环（:633-719 移植）；
 * - 渐隐 mask 只在溢出且对应侧有滚动余量时显示（:664-677）；激活 tab 被遮时
 *   按真实 DOM rect 平滑滚回可视区（:721-762）；
 * - tab 触发器真实 DOM 为 div（× 是内嵌原生 button，避免 button 嵌套 button——
 *   ZCode SidePaneTabTrigger.tsx:110-116 同因）；dnd 拖拽排序为 ZCode
 *   DndContext+SortableContext（:1050-1130）的 desktop 等价：保持初始渲染
 *   顺序，被拖 tab translateX 跟手、途经邻居按 tab 宽度平移让位，跨越中点
 *   更新落位 index，松手提交 store.moveTab。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  useRightPanelStore,
  type PanelTab,
} from "../../stores/rightPanelStore.ts";
import { pathKey } from "../../core/panelPaths.ts";
import {
  Maximize2Icon,
  MessageCircleIcon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PlusIcon,
  XIcon,
} from "../icons.tsx";
import { ContextMenu, type ContextMenuEntry } from "../ContextMenu.tsx";
import {
  PanelTabIcon,
  panelTabTitle,
  panelTabTooltip,
  resolveTabsOverflow,
} from "./panelTabModel.tsx";
import {
  GHOST_ICON_MD,
  TabOverviewPopover,
} from "./TabOverviewPopover.tsx";

/** 完整视图对话 tab（ZCode ConversationTab.tsx:17-38 类串，token 换 desktop）。 */
const CONVERSATION_TAB_CLASS =
  "group relative inline-flex h-7 max-w-60 shrink-0 items-center justify-start gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border px-1.5 pr-2 text-ui-base font-medium transition-colors outline-none cursor-default border-transparent bg-transparent text-ink-subtle hover:text-ink hover:bg-hover data-active:bg-selected data-active:text-ink focus-visible:ring-[3px] focus-visible:ring-info/50";

/** tab 触发器根类串（ZCode SidePaneTabTrigger.tsx:144-155，token 换 desktop）。 */
const TAB_TRIGGER_CLASS =
  "group relative inline-flex h-7 min-w-15 max-w-39 flex-[1_1_9.75rem] items-center justify-start gap-1 overflow-hidden whitespace-nowrap rounded-lg border px-1.5 pr-2 text-ui-base font-medium transition-colors outline-none cursor-default border-transparent bg-transparent text-ink-subtle hover:text-ink hover:bg-hover data-active:bg-selected data-active:text-ink focus-visible:ring-[3px] focus-visible:ring-info/50";

/** tab 标题行：向 × 区域 8px 渐隐防重叠（ZCode :240-247 原文）。 */
const TAB_CONTENT_CLASS =
  "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]";

/** ×关闭钮（ZCode :164-184；基色 text-ink 对齐 ghost text-foreground 100%）。 */
const TAB_CLOSE_CLASS =
  "absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-ink transition-opacity hover:bg-hover hover:text-ink";

const EMPTY_MASK_EDGES = { left: false, right: false } as const;

/** 100ms 两拍关菜单（ContextMenu 宿主约定，ContextBar 同款）。 */
function useContextMenuState(): {
  menu: { x: number; y: number } | null;
  closing: boolean;
  open: (placement: { x: number; y: number }) => void;
  dismiss: () => void;
} {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const dismiss = useCallback(() => {
    setClosing(true);
    window.setTimeout(() => {
      setClosing(false);
      setMenu(null);
    }, 100);
  }, []);
  return {
    menu,
    closing,
    open: (placement) => {
      setClosing(false);
      setMenu(placement);
    },
    dismiss,
  };
}

function PanelTabTrigger({
  project,
  tab,
  active,
  canCloseOtherTabs,
  fullViewActive,
  dragTransform,
  isDragged,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerEnd,
  suppressClickRef,
}: {
  readonly project: string;
  readonly tab: PanelTab;
  readonly active: boolean;
  readonly canCloseOtherTabs: boolean;
  readonly fullViewActive: boolean;
  /** 拖拽中的位移：被拖 tab 跟手，邻居让位；null = 未参与。 */
  readonly dragTransform: string | null;
  readonly isDragged: boolean;
  readonly onDragPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onDragPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onDragPointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly suppressClickRef: RefObject<boolean>;
}) {
  const { menu, closing, open, dismiss } = useContextMenuState();
  const title = panelTabTitle(tab);
  const activate = (): void => {
    // 拖拽落位后的 click 不再激活（ZCode PointerSensor 激活约束同语义）。
    if (suppressClickRef.current) return;
    const store = useRightPanelStore.getState();
    store.activate(project, tab.id);
    // 完整视图内点面板 tab：surface 同步回 side-pane（ZCode activateSidePaneTab 语义）。
    if (fullViewActive) store.fullViewPatch(project, { surface: "side-pane" });
  };
  const close = (): void =>
    useRightPanelStore.getState().closeTab(project, tab.id);
  return (
    <>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={0}
        data-side-pane-tab-id={tab.id}
        data-active={active ? "" : undefined}
        title={panelTabTooltip(tab)}
        className={`${TAB_TRIGGER_CLASS}${
          isDragged ? " relative z-50 bg-selected! shadow-lg will-change-transform" : ""
        }${
          dragTransform && !isDragged
            ? " transition-[transform] duration-150"
            : ""
        }`}
        style={dragTransform ? { transform: dragTransform } : undefined}
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerEnd}
        onPointerCancel={onDragPointerEnd}
        onClick={(event) => {
          // 中键可能同时派发 click/auxclick：先在 click 阶段拦截，避免
          // 关闭前把 tab 激活（ZCode :117-124 同款）。
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          activate();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          // 中键关闭：取消浏览器默认自动滚动，保持原激活 tab 不变（ZCode :134-143）。
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          open({ x: event.clientX, y: event.clientY });
        }}
      >
        <span
          className={`${TAB_CONTENT_CLASS} ${
            active
              ? "[--tab-fade-offset:1.25rem]"
              : "[--tab-fade-offset:0px] group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]"
          }`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <PanelTabIcon tab={tab} />
          </span>
          <span className="shrink-0 whitespace-nowrap">{title}</span>
          {tab.kind === "diff" && (
            <span className="ml-0.5 shrink-0 rounded-full border border-border bg-surface px-1 py-0 text-ui-xs leading-3 text-ink-subtle">
              Diff
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label={`关闭 ${title}`}
          className={`${TAB_CLOSE_CLASS}${
            active
              ? ""
              : " pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          }`}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {menu && (
        <ContextMenu
          label="标签菜单"
          entries={
            [
              {
                id: "close-tab",
                label: "关闭标签",
                onSelect: close,
              },
              {
                id: "close-other-tabs",
                label: "关闭其他标签",
                disabled: !canCloseOtherTabs,
                onSelect: () =>
                  useRightPanelStore
                    .getState()
                    .closeOthers(project, tab.id),
              },
              {
                id: "close-all-tabs",
                label: "关闭所有标签",
                onSelect: () =>
                  useRightPanelStore.getState().closeAll(project),
              },
            ] satisfies ContextMenuEntry[]
          }
          placement={{ x: menu.x, y: menu.y, side: "bottom" }}
          closing={closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

export function PanelTabStrip({
  project,
}: {
  readonly project: string;
  /** 与 ProjectPanel 同参；aside hidden 时按钮本就不可交互，仅作 API 对齐。 */
  readonly visible: boolean;
}) {
  const panel = useRightPanelStore(
    (state) => state.projects[pathKey(project)] ?? undefined,
  );
  const tabs = panel?.tabs ?? [];
  const fullView = panel?.open ? panel.fullView : undefined;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [maskEdges, setMaskEdges] = useState<{ left: boolean; right: boolean }>(
    EMPTY_MASK_EDGES,
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      setOverflowing(false);
      setMaskEdges((current) =>
        current.left || current.right ? EMPTY_MASK_EDGES : current,
      );
      return;
    }
    const updateOverflowState = (): void => {
      const maxScrollLeft = Math.max(
        0,
        viewport.scrollWidth - viewport.clientWidth,
      );
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      const isOverflowing = resolveTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: tabs.length,
        viewportWidth: viewport.clientWidth,
      });
      setOverflowing(isOverflowing);
      setMaskEdges((current) => {
        const next = {
          left: isOverflowing && viewport.scrollLeft > 1,
          right: isOverflowing && viewport.scrollLeft < maxScrollLeft - 1,
        };
        if (current.left === next.left && current.right === next.right) {
          return current;
        }
        return next;
      });
    };
    // RAF 去抖合并 resize 批次（ZCode :680-689）
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };
    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tabs]);

  // 激活 tab 被遮时按真实 DOM rect 滚回可视区（ZCode :721-762）
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!panel?.active || !viewport || !content) return;
    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      if (typeof viewport.scrollBy !== "function") return;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === panel.active);
      if (!activeTab) return;
      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;
      if (leftOverflow < 0) {
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }
      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [panel?.active, tabs]);

  const activateTab = useCallback(
    (id: string): void => {
      const store = useRightPanelStore.getState();
      store.activate(project, id);
      if (useRightPanelStore.getState().projects[pathKey(project)]?.fullView)
        store.fullViewPatch(project, { surface: "side-pane" });
    },
    [project],
  );
  // —— 拖拽排序（ZCode DndContext :1050-1130 的 desktop 等价）——
  // pointer 拖拽期间保持初始渲染顺序：被拖 tab translateX 跟手，落位区间内
  // 的邻居按被拖 tab 宽度平移让位；跨越相邻 tab 中点更新 to，松手提交。
  const [tabDrag, setTabDrag] = useState<{
    id: string;
    from: number;
    to: number;
    dx: number;
    width: number;
  } | null>(null);
  const tabDragRef = useRef<{
    id: string;
    from: number;
    to: number;
    dx: number;
    width: number;
  } | null>(null);
  const tabDragStartRef = useRef<{
    pointerId: number;
    id: string;
    startX: number;
    rects: { id: string; left: number; width: number }[];
  } | null>(null);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);
  const applyTabDrag = useCallback(
    (next: {
      id: string;
      from: number;
      to: number;
      dx: number;
      width: number;
    } | null) => {
      tabDragRef.current = next;
      setTabDrag(next);
    },
    [],
  );
  const beginTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tab: PanelTab): void => {
      if (event.button !== 0 || !contentRef.current) return;
      const content = contentRef.current;
      const rects = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.dataset.sidePaneTabId ?? "",
          left: rect.left,
          width: rect.width,
        };
      });
      if (!rects.some((rect) => rect.id === tab.id)) return;
      suppressClickRef.current = false;
      didDragRef.current = false;
      tabDragStartRef.current = {
        pointerId: event.pointerId,
        id: tab.id,
        startX: event.clientX,
        rects,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const moveTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const start = tabDragStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const dx = event.clientX - start.startX;
      if (!didDragRef.current) {
        // 激活约束：位移超过 5px 才算拖拽（ZCode PointerSensor distance:5 同款）。
        if (Math.abs(dx) < 5) return;
        didDragRef.current = true;
      }
      const from = start.rects.findIndex((rect) => rect.id === start.id);
      const dragged = start.rects[from];
      if (from < 0 || !dragged) return;
      const draggedCenter = dragged.left + dragged.width / 2 + dx;
      let to = from;
      start.rects.forEach((rect, index) => {
        if (index === from) return;
        const center = rect.left + rect.width / 2;
        if (index < from && draggedCenter < center) to = Math.min(to, index);
        if (index > from && draggedCenter > center) to = Math.max(to, index);
      });
      const current = tabDragRef.current;
      if (
        current &&
        current.id === start.id &&
        current.to === to &&
        current.dx === dx
      )
        return;
      applyTabDrag({ id: start.id, from, to, dx, width: dragged.width });
    },
    [applyTabDrag],
  );
  const endTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const start = tabDragStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      tabDragStartRef.current = null;
      const current = tabDragRef.current;
      applyTabDrag(null);
      if (didDragRef.current) {
        didDragRef.current = false;
        if (current && current.to !== current.from) {
          useRightPanelStore.getState().moveTab(project, current.id, current.to);
        }
        // click 在 pointerup 后同步派发，拖过的 tab 本轮 click 不激活。
        suppressClickRef.current = true;
      }
    },
    [applyTabDrag, project],
  );
  const plusButton = (
    <button
      type="button"
      aria-label="新增标签"
      data-side-pane-add-trigger=""
      className={GHOST_ICON_MD}
      onClick={() => {
        const store = useRightPanelStore.getState();
        if (fullView) store.fullViewPatch(project, { surface: "side-pane" });
        store.openNewTab(project);
      }}
    >
      <PlusIcon className="size-4" />
    </button>
  );
  const maskClass = overflowing
    ? maskEdges.left && maskEdges.right
      ? " [mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)]"
      : maskEdges.left
        ? " [mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)]"
        : maskEdges.right
          ? " [mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)]"
          : ""
    : "";

  return (
    <div className="flex h-12 w-full shrink-0 items-center justify-start overflow-hidden border-b border-border/50 bg-transparent p-0">
      <div className="flex min-w-0 flex-1 items-center justify-start">
        {/* 总览槽（ZCode :1039；与 WorkspaceHeader 的 p-2 对齐） */}
        <div className="flex h-full shrink-0 items-center p-2">
          <TabOverviewPopover
            tabs={tabs}
            activeTabId={panel?.active ?? ""}
            recentlyClosed={panel?.recentlyClosed ?? []}
            onActivateTab={activateTab}
            onCloseTab={(id) =>
              useRightPanelStore.getState().closeTab(project, id)
            }
            onReopenClosedTab={(id) =>
              useRightPanelStore.getState().reopenClosed(project, id)
            }
          />
        </div>
        {fullView && (
          // 对话 tab 槽（ZCode :1043，仅 fullView 存在时渲染）
          <div className="flex h-full shrink-0 items-center pr-1">
            <button
              type="button"
              data-testid="full-view-conversation-tab"
              data-active={fullView.surface === "conversation" ? "" : undefined}
              title="对话"
              className={CONVERSATION_TAB_CLASS}
              onClick={() => {
                const store = useRightPanelStore.getState();
                if (fullView)
                  store.fullViewPatch(project, { surface: "conversation" });
                else store.fullViewOpen(project, "conversation");
              }}
            >
              <MessageCircleIcon className="size-4 shrink-0" />
              <span className="min-w-0 truncate">对话</span>
            </button>
          </div>
        )}
        <div
          ref={viewportRef}
          data-side-pane-tabs-viewport=""
          className={`h-12 min-w-0 flex-1 overflow-x-auto scrollbar-hide${maskClass}`}
        >
          <div
            ref={contentRef}
            role="tablist"
            aria-label="内容标签"
            data-side-pane-tabs-content=""
            className="flex w-full gap-1 py-2.5"
          >
            {tabs.map((tab, index) => {
              const isDragged = tabDrag?.id === tab.id;
              let dragTransform: string | null = null;
              if (tabDrag) {
                if (isDragged) {
                  dragTransform = `translateX(${tabDrag.dx}px)`;
                } else if (
                  tabDrag.to < tabDrag.from &&
                  index >= tabDrag.to &&
                  index < tabDrag.from
                ) {
                  dragTransform = `translateX(${tabDrag.width}px)`;
                } else if (
                  tabDrag.to > tabDrag.from &&
                  index > tabDrag.from &&
                  index <= tabDrag.to
                ) {
                  dragTransform = `translateX(${-tabDrag.width}px)`;
                }
              }
              return (
                <PanelTabTrigger
                  key={tab.id}
                  project={project}
                  tab={tab}
                  active={panel?.active === tab.id}
                  canCloseOtherTabs={tabs.length > 1}
                  fullViewActive={fullView !== undefined}
                  dragTransform={dragTransform}
                  isDragged={isDragged}
                  onDragPointerDown={(event) => beginTabDrag(event, tab)}
                  onDragPointerMove={moveTabDrag}
                  onDragPointerEnd={endTabDrag}
                  suppressClickRef={suppressClickRef}
                />
              );
            })}
            {!overflowing && plusButton}
          </div>
        </div>
        {/* 右簇（ZCode :1133-1136 顺序：+（溢出时）→ fullView 开关 → 关闭右栏；
            关闭右栏钮常亮选中底色 bg-selected!（ZCode 展开态 !bg-selected 同款，
            important 压过 ghost 的 hover:bg-hover）） */}
        <div className="ml-auto flex h-full shrink-0 items-center gap-1 px-2">
          {overflowing && plusButton}
          <button
            type="button"
            data-testid="full-view-toggle"
            aria-label={fullView ? "退出完整视图" : "进入完整视图"}
            aria-pressed={fullView !== undefined}
            data-active={fullView !== undefined ? "true" : "false"}
            className={GHOST_ICON_MD}
            onClick={() => {
              const store = useRightPanelStore.getState();
              if (fullView) store.fullViewExit(project);
              else store.fullViewOpen(project, "side-pane");
            }}
          >
            {fullView ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </button>
          <button
            type="button"
            aria-label="关闭右栏"
            className={`${GHOST_ICON_MD} bg-selected!`}
            onClick={() => useRightPanelStore.getState().collapse(project)}
          >
            <PanelRightCloseIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
