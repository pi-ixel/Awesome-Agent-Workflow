/**
 * 完整视图宿主（ZCode side-pane-full-view/ConversationHost.tsx:412-608 移植）。
 * 包住中央内容区唯一的 SessionView 实例，只改变定位方式，不移动 DOM、不重挂载：
 * - normal：静态布局，与原布局一致；
 * - conversation：fixed 铺满 slot（右栏内容区，tab 条下方容器），对话全宽；
 * - floating：fixed 浮在 slot 内的吸附位置，收起态只露出底部输入区。
 * 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，
 * 避免每次测量重渲染对话树（ConversationHost.tsx:2-6 同款约定）。
 *
 * 范围裁剪（对齐规格）：回答气泡（:431-461）、阻塞交互自动恢复（:288-297）、
 * ConversationPanePresentationContext（desktop 经 [data-composer-dock] 直测
 * 输入区高度）与把手 DropdownMenu（专用钮承担）不移植。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  MessageCircleIcon,
  MinimizeIcon,
} from "../icons.tsx";
import {
  emptyPanel,
  useRightPanelStore,
  type PanelFullView,
} from "../../stores/rightPanelStore.ts";
import { pathKey } from "../../core/panelPaths.ts";
import { hostRuntime } from "../../core/host.ts";
// TODO(临时诊断): 完整视图空白问题排查用，定位后删除
import { createLogger } from "../../core/logger.ts";
const rectLogger = createLogger("full-view-debug");

// TODO(临时诊断): 量测同时落本地文件（~/aaw-full-view-debug.log），
// 排查者无需 UI 即可读取；定位后随 TODO 一并删除。
const debugLines: string[] = [];
let debugFlushing = false;
function pushDebugLine(line: string): void {
  debugLines.push(`[${new Date().toISOString()}] ${line}`);
  if (debugFlushing) {
    return;
  }
  debugFlushing = true;
  void (async () => {
    try {
      const home = await hostRuntime.homeDir?.();
      if (!home) return;
      const base = home.replace(/\\/g, "/");
      await hostRuntime.writeTextFile(
        `${base}/aaw-full-view-debug.log`,
        debugLines.join("\n"),
      );
    } catch {
      // 诊断文件写失败不影响主流程
    } finally {
      debugFlushing = false;
    }
  })();
}
import { useRightPanelSlot } from "./fullViewContext.ts";
import { GHOST_ICON_SM } from "./TabOverviewPopover.tsx";

const FLOATING_HEADER_HEIGHT_PX = 40;
/** 操作栏隐藏时抽屉藏在输入框后面的高度；聚焦时从这里向上滑出。 */
const DRAWER_TUCK_UNDER_COMPOSER_PX = 16;
const FLOATING_MARGIN_PX = 16;
const FLOATING_WIDTH_PX = 560;
const FLOATING_EXPANDED_MAX_HEIGHT_PX = 640;
const FLOATING_MINIMIZED_SIZE_PX = 48;
/** 指针移动不足该距离时，⠿ 与圆形按钮按点击处理。 */
const FLOATING_DRAG_CLICK_THRESHOLD_PX = 4;
const FLOATING_ANCHORS: readonly PanelFullView["anchor"][] = [
  "top-left",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
const DEFAULT_FLOATING_ANCHOR: PanelFullView["anchor"] = "bottom-right";
const GEOMETRY_PROPERTIES = ["left", "top", "width", "height"] as const;
const GEOMETRY_VARIABLES = [
  "--side-pane-full-view-frame-width",
  "--side-pane-full-view-pane-height",
  "--side-pane-full-view-clip-height",
  "--side-pane-full-view-drawer-height",
] as const;

interface FloatingRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
interface FloatingPosition {
  readonly left: number;
  readonly top: number;
}
interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPosition;
  moved: boolean;
}

function resolveFloatingWidth(slotWidth: number): number {
  return Math.max(0, Math.min(FLOATING_WIDTH_PX, slotWidth - FLOATING_MARGIN_PX * 2));
}
function resolveFloatingExpandedHeight(slotHeight: number): number {
  return Math.max(
    0,
    Math.min(FLOATING_EXPANDED_MAX_HEIGHT_PX, slotHeight - FLOATING_MARGIN_PX * 2),
  );
}
function clampFloatingPosition(
  position: FloatingPosition,
  slot: FloatingRect,
  size: { width: number; height: number },
): FloatingPosition {
  const maxLeft = slot.left + slot.width - size.width;
  const maxTop = slot.top + slot.height - size.height;
  return {
    left: Math.max(slot.left, Math.min(position.left, maxLeft)),
    top: Math.max(slot.top, Math.min(position.top, maxTop)),
  };
}
function resolveFloatingPosition(
  anchor: PanelFullView["anchor"],
  slot: FloatingRect,
  size: { width: number; height: number },
): FloatingPosition {
  const m = FLOATING_MARGIN_PX;
  const horizontal = anchor.includes("left")
    ? "start"
    : anchor.includes("right")
      ? "end"
      : "center";
  const vertical = anchor.startsWith("top")
    ? "start"
    : anchor.startsWith("bottom")
      ? "end"
      : "center";
  const left =
    horizontal === "start"
      ? slot.left + m
      : horizontal === "end"
        ? slot.left + slot.width - m - size.width
        : slot.left + (slot.width - size.width) / 2;
  const top =
    vertical === "start"
      ? slot.top + m
      : vertical === "end"
        ? slot.top + slot.height - m - size.height
        : slot.top + (slot.height - size.height) / 2;
  return clampFloatingPosition({ left, top }, slot, size);
}
/** 最小化与恢复之间切换的缩放原点（model.ts:109-113）。 */
function resolveFloatingTransformOrigin(anchor: PanelFullView["anchor"]): string {
  const x = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : "center";
  const y = anchor.startsWith("top") ? "top" : anchor.startsWith("bottom") ? "bottom" : "center";
  return `${x} ${y}`;
}
/** 松手时按「窗口当前位置与各吸附位置静止坐标」的距离选最近的吸附点。 */
export function resolveNearestFloatingAnchor(
  position: FloatingPosition,
  slot: FloatingRect,
  size: { width: number; height: number },
): PanelFullView["anchor"] {
  let best: PanelFullView["anchor"] = DEFAULT_FLOATING_ANCHOR;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of FLOATING_ANCHORS) {
    const resting = resolveFloatingPosition(anchor, slot, size);
    const distance = Math.hypot(
      resting.left - position.left,
      resting.top - position.top,
    );
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

function readSlotRect(slot: HTMLElement): FloatingRect {
  const rect = slot.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** 三态映射入口：从右栏 store 派生 mode 与浮窗参数（contract.ts:31）。 */
export function FullViewHost({
  project,
  children,
}: {
  readonly project: string | null;
  readonly children: ReactNode;
}) {
  const panel = useRightPanelStore((state) =>
    project ? (state.projects[pathKey(project)] ?? emptyPanel) : emptyPanel,
  );
  const fullView = panel.open ? panel.fullView : undefined;
  const mode = !fullView
    ? "normal"
    : fullView.surface === "conversation"
      ? "conversation"
      : "floating";
  const slotElement = useRightPanelSlot();
  return (
    <FullViewHostFrame
      mode={mode}
      floating={fullView?.floating ?? "collapsed"}
      anchor={fullView?.anchor ?? DEFAULT_FLOATING_ANCHOR}
      slotElement={slotElement}
      onFloatingChange={(floating) => {
        if (project)
          useRightPanelStore.getState().fullViewPatch(project, { floating });
      }}
      onAnchorChange={(anchor) => {
        if (project)
          useRightPanelStore.getState().fullViewPatch(project, { anchor });
      }}
    >
      {children}
    </FullViewHostFrame>
  );
}

function FullViewHostFrame({
  mode,
  floating,
  anchor,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  children,
}: {
  readonly mode: "normal" | "conversation" | "floating";
  readonly floating: PanelFullView["floating"];
  readonly anchor: PanelFullView["anchor"];
  readonly slotElement: HTMLElement | null;
  readonly onFloatingChange: (floating: PanelFullView["floating"]) => void;
  readonly onAnchorChange: (anchor: PanelFullView["anchor"]) => void;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  const [focusWithin, setFocusWithin] = useState(false);
  const [dragging, setDragging] = useState(false);
  const headerVisible =
    isFloating && !isMinimized && (isExpanded || focusWithin || dragging);
  const dockHeightRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  /** 上一次写入的几何是否为最小化形态；用来识别最小化与恢复之间的切换。 */
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyGeometryRef = useRef<() => void>(() => {});

  const resolveFrameSize = useCallback(
    (slot: FloatingRect) => {
      if (isMinimized) {
        return {
          width: FLOATING_MINIMIZED_SIZE_PX,
          height: FLOATING_MINIMIZED_SIZE_PX,
        };
      }
      const paneHeight = Math.max(
        0,
        resolveFloatingExpandedHeight(slot.height) - FLOATING_HEADER_HEIGHT_PX,
      );
      const headerHeight = headerVisible ? FLOATING_HEADER_HEIGHT_PX : 0;
      // 收起态外层就是输入框本身；展开态输入层在抽屉内缩 1px，露出抽屉边框。
      const clipHeight = isExpanded
        ? Math.max(0, paneHeight - 1)
        : Math.min(dockHeightRef.current, paneHeight);
      const height = headerHeight + (isExpanded ? paneHeight : clipHeight);
      return {
        width: resolveFloatingWidth(slot.width),
        height,
        paneHeight: isExpanded ? clipHeight : paneHeight,
        clipHeight,
        // 操作栏可见时抽屉一直延伸到浮窗底边，两侧边线连续（:211-213 同款修复）。
        drawerHeight: headerVisible ? height : DRAWER_TUCK_UNDER_COMPOSER_PX,
      };
    },
    [headerVisible, isExpanded, isMinimized],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode === "normal" || !slotElement) {
      pushDebugLine(`normal mode=${mode} slot=${slotElement ? "有" : "无"}`);
      for (const property of GEOMETRY_PROPERTIES)
        host.style.removeProperty(property);
      for (const variable of GEOMETRY_VARIABLES)
        host.style.removeProperty(variable);
      applyGeometryRef.current = () => {};
      appliedMinimizedRef.current = null;
      return;
    }
    const apply = (): void => {
      const slot = readSlotRect(slotElement);
      if (mode === "conversation") {
        host.style.left = `${slot.left}px`;
        host.style.top = `${slot.top}px`;
        host.style.width = `${slot.width}px`;
        host.style.height = `${slot.height}px`;
        // TODO(临时诊断): 定位后删除
        requestAnimationFrame(() => {
          const hostRect = host.getBoundingClientRect();
          const list = host.querySelector("[aria-label='消息流']");
          const listRect = list?.getBoundingClientRect();
          const composer = host.querySelector("[data-composer]");
          const composerRect = composer?.getBoundingClientRect();
          rectLogger.info("完整视图几何", {
            slot,
            host: hostRect,
            listRect: listRect ?? null,
            composerTag: composer?.tagName ?? null,
            hostChildren: host.children.length,
          });
          pushDebugLine(
            `conversation slot={l:${slot.left.toFixed(0)},t:${slot.top.toFixed(0)},w:${slot.width.toFixed(0)},h:${slot.height.toFixed(0)}} host={l:${hostRect.left.toFixed(0)},t:${hostRect.top.toFixed(0)},w:${hostRect.width.toFixed(0)},h:${hostRect.height.toFixed(0)}} list=${listRect ? `l:${listRect.left.toFixed(0)},t:${listRect.top.toFixed(0)},w:${listRect.width.toFixed(0)},h:${listRect.height.toFixed(0)}` : "null"} composer=${composerRect ? `t:${composerRect.top.toFixed(0)},h:${composerRect.height.toFixed(0)}` : "null"} children=${host.children.length}`,
          );
        });
        return;
      }
      const size = resolveFrameSize(slot);
      // 最小化与恢复之间切换时几何直接到位，只做从按钮所在角缩放 + 淡入；
      // 否则恢复时 48px→560px 的过渡会让输入框先折行再缩回（:239-244 同款修复）。
      const crossingMinimized =
        appliedMinimizedRef.current !== null &&
        appliedMinimizedRef.current !== isMinimized;
      appliedMinimizedRef.current = isMinimized;
      if (crossingMinimized) host.style.transition = "none";
      // 内部内容始终按浮窗宽度排版：最小化期间也不跟着 48px 重排。
      host.style.setProperty(
        "--side-pane-full-view-frame-width",
        `${resolveFloatingWidth(slot.width)}px`,
      );
      if ("paneHeight" in size) {
        host.style.setProperty(
          "--side-pane-full-view-pane-height",
          `${size.paneHeight}px`,
        );
        host.style.setProperty(
          "--side-pane-full-view-clip-height",
          `${size.clipHeight}px`,
        );
        host.style.setProperty(
          "--side-pane-full-view-drawer-height",
          `${size.drawerHeight}px`,
        );
      }
      const position = dragPositionRef.current
        ? clampFloatingPosition(dragPositionRef.current, slot, size)
        : resolveFloatingPosition(anchor, slot, size);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      if (crossingMinimized) {
        // 强制提交一次样式，让几何不带过渡生效，再恢复 CSS 过渡。
        void host.offsetWidth;
        host.style.removeProperty("transition");
        host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
        host.animate?.(
          [
            { opacity: 0, transform: "scale(0.92)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 150, easing: "ease-out" },
        );
      }
    };
    applyGeometryRef.current = apply;
    apply();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resizeObserver?.observe(slotElement);
    window.addEventListener("resize", apply);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [anchor, isMinimized, mode, resolveFrameSize, slotElement]);

  // 底部输入区实测高（SessionDock+ChatInput 包裹层）：浮窗收起态按它裁剪
  // （对齐 ZCode reportComposerDockHeight :177-181，desktop 直测 DOM）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const dock = host.querySelector<HTMLElement>("[data-composer-dock]");
    if (!dock) return;
    const apply = (): void => {
      const height = dock.offsetHeight;
      if (dockHeightRef.current === height) return;
      dockHeightRef.current = height;
      applyGeometryRef.current();
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  const focusComposer = useCallback((): void => {
    window.requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector<HTMLElement>("[data-composer-dock] textarea")
        ?.focus();
    });
  }, []);

  const handleFocusCapture = useCallback(() => setFocusWithin(true), []);
  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setFocusWithin(false);
    },
    [],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const host = hostRef.current;
      if (!host) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = host.getBoundingClientRect();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { left: rect.left, top: rect.top },
        moved: false,
      };
    },
    [],
  );
  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX)
        return;
      if (!session.moved) {
        session.moved = true;
        setDragging(true);
      }
      dragPositionRef.current = {
        left: session.origin.left + dx,
        top: session.origin.top + dy,
      };
      applyGeometryRef.current();
    },
    [],
  );
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!session.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const dropped = dragPositionRef.current;
      dragPositionRef.current = null;
      setDragging(false);
      if (!host || !dropped || !slotElement) return;
      const slot = readSlotRect(slotElement);
      const rect = host.getBoundingClientRect();
      const nextAnchor = resolveNearestFloatingAnchor(
        clampFloatingPosition(dropped, slot, rect),
        slot,
        { width: rect.width, height: rect.height },
      );
      if (nextAnchor === anchor) {
        applyGeometryRef.current();
      } else {
        onAnchorChange(nextAnchor);
      }
    },
    [anchor, onAnchorChange, slotElement],
  );
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dragPositionRef.current = null;
    setDragging(false);
    applyGeometryRef.current();
  }, []);

  const handleToggleExpanded = useCallback((): void => {
    onFloatingChange(isExpanded ? "collapsed" : "expanded");
  }, [isExpanded, onFloatingChange]);
  const handleMinimize = useCallback((): void => {
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  const handleRestore = useCallback((): void => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);

  const expandLabel = isExpanded ? "收起消息" : "展开消息";
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <div
      ref={hostRef}
      data-testid="full-view-host"
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      onFocusCapture={isFloating ? handleFocusCapture : undefined}
      onBlurCapture={isFloating ? handleBlurCapture : undefined}
      className={
        mode === "normal"
          ? "relative h-full w-full"
          : mode === "conversation"
            ? "fixed z-40 flex flex-col"
            : "fixed z-40 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none"
      }
    >
      {isFloating && !isMinimized ? (
        // 抽屉层：在输入框后面，聚焦时随浮窗变高从输入框后面向上滑出；展开时铺满整个浮窗。
        <div
          data-testid="full-view-drawer"
          data-open={headerVisible ? "true" : "false"}
          className={`absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-2xl border border-border bg-base shadow-lg transition-[height,opacity] duration-150 ease-out ${
            headerVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          {headerVisible ? (
            <div
              data-testid="full-view-header"
              data-expanded={isExpanded ? "true" : "false"}
              className="flex h-10 items-center gap-1 px-2"
              // 不挂点击行为，只阻止 mousedown 抢走输入框焦点（:478-480 同款）。
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                data-testid="full-view-minimize"
                aria-label="最小化编辑器"
                className={GHOST_ICON_SM}
                onClick={handleMinimize}
              >
                {/* ZCode MinusIcon（ConversationHost:490）——desktop 既有
                    MinimizeIcon（icons.tsx:184）即 lucide minus 同字形，直接复用 */}
                <MinimizeIcon className="size-4" />
              </button>
              <button
                type="button"
                data-testid="full-view-expand"
                aria-label={expandLabel}
                aria-expanded={isExpanded}
                title={expandLabel}
                className={GHOST_ICON_SM}
                onClick={handleToggleExpanded}
              >
                <ExpandIcon className="size-4" />
              </button>
              <div className="min-w-0 flex-1" />
              <button
                type="button"
                data-testid="full-view-handle"
                aria-label="拖动以移动"
                title="拖动以移动"
                className={`${GHOST_ICON_SM} cursor-grab touch-none`}
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                // 位移不足阈值视为点击：把手无专用菜单（范围裁剪），无操作。
                onPointerUp={(event) => endDrag(event, () => {})}
                onPointerCancel={cancelDrag}
              >
                <GripVerticalIcon className="size-4" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {isMinimized ? (
        <button
          type="button"
          data-testid="full-view-bubble"
          aria-label="展开编辑器"
          className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-base shadow-lg hover:bg-hover"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => endDrag(event, handleRestore)}
          onPointerCancel={cancelDrag}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleRestore();
            }
          }}
        >
          <MessageCircleIcon className="size-4 text-ink-subtle" />
        </button>
      ) : null}
      <div
        data-side-pane-full-view-clip=""
        className={
          "relative min-h-0" +
          (mode === "normal" ? " h-full" : "") +
          (mode === "conversation" ? " flex-1" : "") +
          // 输入层：收起态外壳就是输入框（带阴影），展开态内缩 1px 露出抽屉边框。
          (isFloating
            ? " absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden"
            : "") +
          (isFloating && !isExpanded ? " inset-x-0 bottom-0 rounded-2xl shadow-lg" : "") +
          (isExpanded ? " inset-x-px bottom-px rounded-b-2xl" : "") +
          // 最小化时输入层不可见，但保持浮窗宽度排版，不随 48px 的按钮重排。
          (isMinimized ? " invisible w-[var(--side-pane-full-view-frame-width)]" : "")
        }
      >
        <div
          className={
            "h-full" +
            // 收起态保持展开态的固定高度并贴底：只露出底部输入区，上方内容仍然挂载。
            (isFloating
              ? " absolute inset-x-0 bottom-0 h-[var(--side-pane-full-view-pane-height)]"
              : "")
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
