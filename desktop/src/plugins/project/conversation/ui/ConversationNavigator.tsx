import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { QueryNavigationItem } from "./conversationNavigation.ts";

/** ZCode 式用户提问导航：目录独立滚动，正文仍由最右侧主滚动条控制。 */
export function ConversationNavigator({
  items,
  activeId,
  onJump,
}: {
  items: readonly QueryNavigationItem[];
  activeId: string | null;
  onJump: (item: QueryNavigationItem) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320 });
  const getScrollElement = useCallback(() => railRef.current, []);
  // 虚拟器的可变测量对象由自身订阅驱动，不交给 React Compiler 缓存。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize: () => 10,
    overscan: 6,
    getItemKey: (index) => items[index]?.id ?? index,
  });
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const selected = items.find((item) => item.id === previewId);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setPreviewId(null);
    setFocusIndex(null);
  }, []);
  const scheduleClose = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(close, 80);
  };
  const open = (
    id: string,
    index: number,
    element: HTMLButtonElement,
    delay: number,
  ): void => {
    clearTimeout(timer.current);
    anchorRef.current = element;
    setFocusIndex(index);
    timer.current = setTimeout(() => setPreviewId(id), delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (activeIndex >= 0 && items.length >= 2) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
      const element = railRef.current;
      if (!element) return;
      // 目录从尾部一次扩展到上千项时，scrollToIndex 与 virtualizer 的
      // measurement 更新处于同一个 commit，Chromium 可能合并 scroll 通知。
      // 补发通知只同步 rail observer，确保活动项对应的可视窗口立即挂载；
      // 缺了这一步虚拟窗口会停在原地——轨道已滚到底却仍渲染顶部刻度，
      // 底部刻度永远不出现（ZCode ConversationTurnNavigator 同款补丁）。
      window.queueMicrotask(() => {
        if (railRef.current !== element) return;
        element.dispatchEvent(new Event("scroll"));
      });
    }
  }, [activeIndex, items.length, virtualizer]);
  useLayoutEffect(() => {
    if (!previewId) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const update = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const height = popupRef.current?.offsetHeight ?? 140;
      setPosition({
        width,
        left: Math.max(
          12,
          Math.min(rect.right + 8, window.innerWidth - width - 12),
        ),
        top: Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)),
      });
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!anchor.isConnected || !anchor.getClientRects().length) close();
            else update();
          });
    observer?.observe(anchor);
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !anchor.contains(event.target) &&
        !popupRef.current?.contains(event.target)
      )
        close();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    return () => {
      observer?.disconnect();
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
    };
  }, [previewId, close]);
  if (items.length < 2) return null;
  return (
    <nav
      aria-label="提问导航"
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 opacity-0 transition-opacity motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:opacity-100"
    >
      <div
        ref={railRef}
        onScroll={close}
        onPointerLeave={() => {
          setFocusIndex(null);
          scheduleClose();
        }}
        className="conversation-query-rail pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
      >
        <div
          className="relative w-9"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            if (!item) return null;
            const active = item.id === activeId;
            const distance =
              focusIndex === null ? Infinity : Math.abs(row.index - focusIndex);
            const scale =
              distance === 0
                ? 2.6
                : distance === 1
                  ? 1.7
                  : distance === 2
                    ? 1.25
                    : 1;
            const opacity =
              distance === 0
                ? 1
                : distance === 1
                  ? 0.86
                  : distance === 2
                    ? 0.72
                    : active
                      ? 0.9
                      : item.running
                        ? 0.72
                        : 0.58;
            return (
              <button
                key={row.key}
                type="button"
                aria-label={`跳到第 ${row.index + 1} 条提问`}
                aria-posinset={row.index + 1}
                aria-setsize={items.length}
                aria-current={active ? "location" : undefined}
                aria-describedby={
                  previewId === item.id ? "query-navigation-preview" : undefined
                }
                className="absolute left-0 top-0 flex h-2.5 w-9 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
                style={{ transform: `translateY(${row.start}px)` }}
                onPointerEnter={(event) =>
                  open(item.id, row.index, event.currentTarget, 120)
                }
                onPointerLeave={scheduleClose}
                onFocus={(event) =>
                  open(item.id, row.index, event.currentTarget, 0)
                }
                onBlur={scheduleClose}
                onClick={() => {
                  close();
                  onJump(item);
                }}
              >
                <span
                  className={`block h-0.5 w-3 origin-left rounded-full transition-[transform,opacity] duration-150 motion-reduce:transition-none ${active || distance === 0 ? "bg-ink" : "bg-ink-faint"}`}
                  style={{ opacity, transform: `scaleX(${scale})` }}
                />
              </button>
            );
          })}
        </div>
      </div>
      {selected &&
        createPortal(
          <div
            ref={popupRef}
            id="query-navigation-preview"
            role="tooltip"
            aria-label="提问与回复预览"
            className="fixed z-50 space-y-2 rounded-xl border border-line-strong bg-surface p-3 text-xs leading-5 text-ink shadow-xl"
            style={position}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={scheduleClose}
          >
            <p className="line-clamp-2 whitespace-pre-line break-words font-medium">
              {selected.question}
            </p>
            <p className="line-clamp-3 whitespace-pre-line break-words text-ink-soft">
              {selected.answer}
            </p>
          </div>,
          document.body,
        )}
    </nav>
  );
}
