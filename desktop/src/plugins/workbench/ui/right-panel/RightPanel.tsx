import { describeUnknownError } from "../../../../shared/errors.ts";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { useRightPanelValue, readRightPanel, readWorkbenchUi, useWorkbenchLayout } from "../bindings/layoutView.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { emptyPanel } from "../../layout/rightPanelStore.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";
import { ScopedErrorBoundary } from "../../../../shared/ui/ErrorBoundary.tsx";
import { useWorkbenchPathOpener, useWorkbenchEntries } from "../bindings/react.ts";
import { NewTabPane } from "./NewTabPane.tsx";
import { PanelTabStrip } from "./PanelTabStrip.tsx";
import {
  RightPanelSlideContext,
  RightPanelSlotContext,
  useRightPanelSlotSetter,
  type RightPanelSlotValue,
} from "./fullViewContext.ts";
import {
  DEFAULT_PANEL_RATIO,
  resolvePanelLayout,
} from "../panelLayout.ts";
import "./RightPanel.css";
import { useLayoutMotion } from "../../../../shared/ui/controls/useLayoutMotion.ts";
import { ColumnResizer } from "../../../../shared/ui/controls/ColumnResizer.tsx";
import { EdgeDrawer } from "../../../../shared/ui/controls/EdgeDrawer.tsx";

/** 内容区的子节点位置保持固定，右栏开关仅改变布局，不重挂聊天输入框。 */
export function PanelWorkspace({
  children,
  project,
  enabled,
}: {
  children: ReactNode;
  project: string | null;
  enabled: boolean;
}) {
  const workbenchLayout = useWorkbenchLayout();
  const ref = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const reservationRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const focusBeforeScrim = useRef<HTMLElement | null>(null);
  const previewWidth = (next: number) => {
    if (asideRef.current) asideRef.current.style.width = `${next}px`;
    if (reservationRef.current) reservationRef.current.style.width = `${next}px`;
  };
  const [available, setAvailable] = useState(1200);
  const [drag, setDrag] = useState<{
    project: string;
    width: number;
  } | null>(null);
  // 完整视图 slot：右栏内容区根 div（tab 条下方）的 ref state（fullViewContext）。
  // setSlot 恒稳定，Provider 值只需随 slot 变化；ref 镜像会在渲染期读写
  // ref，被 react-hooks/refs 禁止。
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const slotValue = useMemo<RightPanelSlotValue>(
    () => ({ slot, setSlot }),
    [slot],
  );
  const panel = useRightPanelValue((state) =>
    project ? (state.projects[pathKey(project)] ?? emptyPanel) : emptyPanel,
  );
  // 模型 a 完整视图：surface=side-pane 时会话列隐藏、右栏 flex-1 占满
  // 内容区（对话收成浮窗输入条，由 ContentArea 外层渲染）——不用 fixed，
  // 侧栏与顶栏保持可见（ZCode 完整视图同款布局语义）
  const sidePaneFullScreen =
    panel.open && panel.fullView?.surface === "side-pane";
  const layout = resolvePanelLayout(available, panel.sizeRatio);
  const saveWidth = (target: string, value: number) =>
    readRightPanel(workbenchLayout).resize(target, value / available);
  const width = drag?.project === project ? drag.width : layout.width;
  const maxWidth = layout.maximum;
  // 拖动结束后再切布局，避免中途卸载捕获指针的分隔条而丢失宽度。
  const overlay = drag?.project === project ? false : layout.overlay;
  const open = enabled && project !== null && panel.open;
  const canSlide = enabled && !!project && !overlay && !drag && !sidePaneFullScreen;
  const [slide, setSlide] = useState({
    project,
    open,
    canSlide,
    animated: false,
    heldOpen: null as boolean | null,
  });
  if (slide.project !== project || slide.open !== open || slide.canSlide !== canSlide) {
    const holdWidth = slide.project === project && slide.canSlide && canSlide && slide.open !== open;
    const animated = holdWidth &&
      window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches === true;
    setSlide({
      project, open, canSlide, animated,
      heldOpen: holdWidth ? (slide.heldOpen ?? slide.open) : null,
    });
  }
  const sliding = slide.heldOpen !== null;
  const slideMotion = sliding && slide.animated;
  const finishSlide = useCallback(() => {
    setSlide((current) => current.heldOpen === null ? current : { ...current, heldOpen: null });
  }, []);
  // Allow the conversation to capture its anchor even when motion is disabled.
  // The width then commits within the same paint.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Commit after the child measures the old layout, before paint.
    if (sliding && !slide.animated) finishSlide();
  }, [sliding, slide.animated, finishSlide]);
  useEffect(() => {
    if (!slideMotion) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finishSlide, 260);
    motion?.addEventListener("change", finishSlide);
    return () => {
      window.clearTimeout(timer);
      motion?.removeEventListener("change", finishSlide);
    };
  }, [slideMotion, open, finishSlide]);
  const moving = useLayoutMotion(`${open}:${sidePaneFullScreen}`, {
    enabled: enabled && !!project && !drag,
    scope: project,
    duration: 400,
  });
  const reservesWidth = (slide.heldOpen ?? open) && !overlay;
  const reservedWidth = sidePaneFullScreen ? "100%" : reservesWidth ? `${width}px` : 0;
  const widthMotion = moving && !slide.animated;
  const visible = open || sliding || widthMotion;
  const scrim = open && overlay && !sidePaneFullScreen;
  const panelWidth = Math.min(width, Math.max(280, available - (overlay ? 12 : 0)));
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (scrim && active instanceof HTMLElement && active !== scrimRef.current) {
      focusBeforeScrim.current = active;
    }
    if (!scrim) focusBeforeScrim.current = null;
  }, [scrim]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open || !project) return;
    const close = (event: KeyboardEvent): void => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        readWorkbenchUi(workbenchLayout).overlay !== "settings"
      ) {
        const restore = document.activeElement === scrimRef.current ? focusBeforeScrim.current : null;
        readRightPanel(workbenchLayout).collapse(project);
        restore?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, project, workbenchLayout]);
  return (
    <div
      ref={ref}
      data-layout-moving={moving || undefined}
      data-panel-slide={slideMotion ? (open ? "opening" : "closing") : undefined}
      data-panel-width-motion={widthMotion || undefined}
      data-panel-dragging={!!drag}
      className="relative flex h-full min-h-0 min-w-0"
    >
      <RightPanelSlotContext.Provider value={slotValue}>
        <div className={`min-h-0 min-w-0 flex-1 ${sidePaneFullScreen ? "pointer-events-none" : ""}`}>
          <RightPanelSlideContext.Provider value={sliding}>{children}</RightPanelSlideContext.Provider>
        </div>
        <div ref={reservationRef} aria-hidden="true" className="workbench-right-reservation shrink-0" style={{ width: reservedWidth }} />
        {project && (scrim || (moving && overlay)) && (
          <ActionButton
            ref={scrimRef}
            tone="ghost"
            aria-label="关闭右栏遮罩"
            inert={!scrim}
            className={`absolute inset-0 z-20 rounded-flat! bg-scrim! focus-visible:ring-inset active:transform-none! ${scrim ? "opacity-100" : "pointer-events-none opacity-0"} ${moving ? "motion-safe:transition-opacity duration-200 ease-out starting:opacity-0" : ""}`}
            onClick={() => {
              const restore = focusBeforeScrim.current;
              readRightPanel(workbenchLayout).collapse(project);
              restore?.focus({ preventScroll: true });
            }}
          />
        )}
        {project && (
          <EdgeDrawer
            side="right"
            drawerRef={asideRef}
            open={open}
            visible={visible}
            sliding={slideMotion || (overlay && widthMotion)}
            aria-label="项目右侧工具栏"
            onSlideEnd={sliding ? finishSlide : undefined}
            className={`min-w-0 bg-base ${slideMotion ? "z-30" : overlay ? "z-30 shadow-floating" : ""}${
              widthMotion && !overlay ? " motion-safe:transition-[width] duration-200 ease-out" : ""
            }${widthMotion && !overlay && open ? " starting:w-0!" : ""}`}
            style={{ width: sidePaneFullScreen ? "100%" : open || overlay || sliding ? `${panelWidth}px` : 0 }}
          >
            {open && !overlay && !sidePaneFullScreen && !sliding && (
              <ColumnResizer
                key={project}
                label="调整右栏宽度"
                placement="overlay"
                growDirection="start"
                minPx={300}
                maxPx={maxWidth}
                defaultWidthPx={resolvePanelLayout(available).width}
                paneRef={asideRef}
                readWidth={() => asideRef.current?.clientWidth || width}
                onPreviewWidth={previewWidth}
                onCommitWidth={(next) => saveWidth(project, next)}
                onReset={() => readRightPanel(workbenchLayout).resize(project, DEFAULT_PANEL_RATIO)}
                cancelBehavior="revert"
                onDraggingChange={(dragging) => setDrag(dragging ? { project, width } : null)}
              />
            )}
            <div className="flex min-h-0 w-full justify-end overflow-hidden border-l border-line">
              <div
                className="flex h-full min-w-0 shrink-0"
                style={{ width: widthMotion && !open && !overlay ? panelWidth : "100%" }}
              >
                <ScopedErrorBoundary scope="项目工具栏" resetKey={project}>
                  <ProjectPanel key={pathKey(project)} project={project} visible={visible} />
                </ScopedErrorBoundary>
              </div>
            </div>
          </EdgeDrawer>
        )}
      </RightPanelSlotContext.Provider>
    </div>
  );
}

function ProjectPanel({
  project,
  visible,
}: {
  project: string;
  visible: boolean;
}) {
  const panel = useRightPanelValue(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  const setSlot = useRightPanelSlotSetter();
  const openWorkbenchPath = useWorkbenchPathOpener();
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const openPath = useCallback(
    (path: string, line?: number): void => {
      if (!openWorkbenchPath) return;
      const generation = ++request.current;
      const isCurrent = () => generation === request.current;
      void openWorkbenchPath(project, path, line, isCurrent)
        .then((opened) => {
          if (opened && isCurrent()) setError(null);
        })
        .catch((cause: unknown) => {
          if (isCurrent()) setError(describeUnknownError(cause));
        });
    },
    [openWorkbenchPath, project],
  );
  const panels = useWorkbenchEntries("panels");
  const activeTab = panel.tabs.find((tab) => tab.id === panel.active);
  const activeView = panels.find(({ id }) => id === activeTab?.kind);
  // 完整视图对话面：中央 SessionView 由 FullViewHost fixed 铺满 slot，
  // 右栏各 pane 一并失活（ZCode contentActiveTabId="" 失活语义的 desktop 等价）。
  const conversationFill =
    panel.open && panel.fullView?.surface === "conversation";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <PanelTabStrip project={project} visible={visible} />
      {error && (
        <p role="alert" className="break-words p-2 text-xs text-danger-ink">
          {error}
        </p>
      )}
      <div
        ref={setSlot}
        data-side-pane-content-slot=""
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {!conversationFill && !activeView && (
          <NewTabPane project={project} />
        )}
        {panels.map((panel) => {
          const active =
            visible && !conversationFill && activeView === panel;
          if (!active && !panel.keepMounted) return null;
          const key =
            panel.key?.({ project, tab: activeTab }) ??
            (panel.keepMounted ? "" : (activeTab?.id ?? ""));
          return (
            <panel.View
              key={`${panel.id}:${key}`}
              project={project}
              tab={activeTab}
              visible={active}
              openPath={openPath}
            />
          );
        })}
      </div>
    </div>
  );
}
