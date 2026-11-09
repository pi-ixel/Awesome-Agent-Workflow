import { panelError } from "../../../../shared/panelError.ts";
import { useRightPanelValue, readWorkbenchUi, readRightPanel, useWorkbenchLayout } from "../../layoutView.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { emptyPanel } from "../../rightPanelStore.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";
import { ScopedErrorBoundary } from "../../../../shared/ui/ErrorBoundary.tsx";
import { useWorkbenchDocuments, useWorkbenchEntries } from "../../react.ts";
import { NewTabPane } from "./NewTabPane.tsx";
import { PanelTabStrip } from "./PanelTabStrip.tsx";
import {
  RightPanelSlotContext,
  useRightPanelSlotSetter,
  type RightPanelSlotValue,
} from "./fullViewContext.ts";
import {
  DEFAULT_PANEL_RATIO,
  resolvePanelLayout,
} from "../panelLayout.ts";
import { useFrameTask } from "../../../../shared/ui/controls/useFrameTask.ts";

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
  const resizeFrame = useFrameTask();
  const [available, setAvailable] = useState(1200);
  const [drag, setDrag] = useState<{
    project: string;
    x: number;
    initial: number;
    width: number;
    pointerId: number;
  } | null>(null);
  const dragRef = useRef(drag);
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
  const clampWidth = (value: number) =>
    Math.min(maxWidth, Math.max(300, value));
  // 拖动结束后再切布局，避免中途卸载捕获指针的分隔条而丢失宽度。
  const overlay = drag?.project === project ? false : layout.overlay;
  const open = enabled && project !== null && panel.open;
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
      if (event.key === "Escape" && !event.defaultPrevented)
        readRightPanel(workbenchLayout).collapse(project);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, project, workbenchLayout]);
  return (
    <div ref={ref} className="relative flex h-full min-h-0 min-w-0">
      <RightPanelSlotContext.Provider value={slotValue}>
        <div hidden={sidePaneFullScreen} className="min-h-0 min-w-0 flex-1">
          {children}
        </div>
        {open && overlay && (
          <button
            aria-label="关闭右栏遮罩"
            className="absolute inset-0 z-20 bg-scrim"
            onClick={() => readRightPanel(workbenchLayout).collapse(project)}
          />
        )}
        {project && (
          <aside
            ref={asideRef}
            hidden={!open}
            aria-label="项目右侧工具栏"
            className={`${open ? "flex" : "hidden"} ${
              sidePaneFullScreen
                ? "min-h-0 min-w-0 flex-1"
                : overlay
                  ? "absolute inset-y-0 right-0 z-30 shadow-xl"
                  : "relative shrink-0"
            } border-l border-line bg-base`}
            style={
              sidePaneFullScreen
                ? undefined
                : {
                    width: `${Math.min(width, Math.max(280, available - (overlay ? 12 : 0)))}px`,
                  }
            }
          >
            {!overlay && (
              <div
                role="separator"
                tabIndex={0}
                aria-label="调整右栏宽度"
                aria-orientation="vertical"
                aria-valuemin={300}
                aria-valuemax={maxWidth}
                aria-valuenow={width}
                className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none"
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    saveWidth(
                      project,
                      clampWidth(
                        width + (event.key === "ArrowLeft" ? 16 : -16),
                      ),
                    );
                  }
                }}
                onDoubleClick={() =>
                  readRightPanel(workbenchLayout)
                    .resize(project, DEFAULT_PANEL_RATIO)
                }
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragRef.current = {
                    project,
                    x: event.clientX,
                    initial: width,
                    width,
                    pointerId: event.pointerId,
                  };
                  setDrag({ ...dragRef.current });
                }}
                onPointerMove={(event) => {
                  const current = dragRef.current;
                  if (current && current.pointerId === event.pointerId) {
                    const next = clampWidth(
                      current.initial + current.x - event.clientX,
                    );
                    current.width = next;
                    resizeFrame.schedule(() => {
                      if (asideRef.current)
                        asideRef.current.style.width = `${next}px`;
                    });
                  }
                }}
                onPointerUp={(event) => {
                  const current = dragRef.current;
                  if (!current || current.pointerId !== event.pointerId) return;
                  resizeFrame.cancel();
                  const next = clampWidth(
                    current.initial + current.x - event.clientX,
                  );
                  if (asideRef.current)
                    asideRef.current.style.width = `${next}px`;
                  saveWidth(current.project, next);
                  dragRef.current = null;
                  setDrag(null);
                }}
                onPointerCancel={() => {
                  if (asideRef.current && dragRef.current)
                    asideRef.current.style.width = `${dragRef.current.initial}px`;
                  dragRef.current = null;
                  setDrag(null);
                  resizeFrame.cancel();
                }}
                onLostPointerCapture={(event) => {
                  const current = dragRef.current;
                  if (!current || current.pointerId !== event.pointerId) return;
                  resizeFrame.flush();
                  saveWidth(current.project, current.width);
                  dragRef.current = null;
                  setDrag(null);
                }}
              >
                <span
                  aria-hidden
                  className="absolute bottom-2 left-1 top-2 w-0.5 rounded-full bg-ink-ghost/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </div>
            )}
            <ScopedErrorBoundary scope="项目工具栏" resetKey={project}>
              <ProjectPanel
                key={pathKey(project)}
                project={project}
                visible={open}
              />
            </ScopedErrorBoundary>
          </aside>
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
  const workbenchLayout = useWorkbenchLayout();
  const panel = useRightPanelValue(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  const setSlot = useRightPanelSlotSetter();
  const documents = useWorkbenchDocuments();
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
      if (!documents) return;
      const generation = ++request.current;
      void documents
        .stat(path)
        .then((entry) => {
          if (
            generation !== request.current ||
            !documents.isActive() ||
            pathKey(readWorkbenchUi(workbenchLayout).contextPath ?? "") !==
              pathKey(project)
          )
            return;
          setError(null);
          const store = readRightPanel(workbenchLayout);
          if (entry.directory) store.openDirectory(project, entry.path);
          else store.openFile(project, entry.path, line);
        })
        .catch((cause: unknown) => {
          if (generation === request.current && documents.isActive())
            setError(panelError(cause));
        });
    },
    [documents, project, workbenchLayout],
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
          <NewTabPane project={project} openPath={openPath} />
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
