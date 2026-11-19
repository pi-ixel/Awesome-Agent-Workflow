/**
 * 流程图画布：运行页、工作流详情、AI 修改的前后对比共用一个。
 * 下钻上下文和缩放控件共用顶部控制带，流程导航浮在滚动视口右上角。
 *
 * 三件原先散在调用方的事收在这里，页面不再各写一遍：
 * - 缩放值（从前三个页面各一份 `useState(1)`）；
 * - 条带宽度 clamp（从前只有运行页量视口，详情页和草稿页传常量，窄面板里直接溢出）；
 * - 进页面即适应（宽、高都放得下才算适应——整张流程图进视口；换内容时再做一次）。
 * - 空白画布上按住拖动 = 平移（卡片、按钮上的按下仍是它们自己的点击）。
 *
 * 另提供一个「不随图缩放」的浮层宿主：内容在 `.workflow-stage` 里整体 zoom，
 * 挂在内容里的绝对定位也会跟着缩放，右上角的流程导航要稳定尺寸，只能挂到宿主上。
 * 宿主是浮层、不占列宽 —— 占一列时条带被挤到下限，整张图被迫缩到 90%；
 * 原型里导航就是压在点阵右上角的一张小卡，画布宽度只由面板决定。
 */
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { moveCardFocus } from "./cardFocus.ts";
import { clampZoom, fitZoom } from "./zoom.ts";
import { bandWidthFor, isNarrow } from "./canvasGeometry.ts";
import { CanvasToolbar } from "./CanvasToolbar.tsx";
import { CanvasOverlayContext, CanvasStripContext } from "./canvasOverlay.ts";

/** 画布交给内容的测量结果：条带宽度、是否窄到要滚动、缩放值。 */
export interface CanvasContext {
  readonly zoom: number;
  /** 条带宽度（clamp(BAND_MIN, 视口 − 内边距×2 − 导轨, BAND_MAX)）。 */
  readonly bandWidth: number;
  /** 面板比「最小条带 + 内边距 + 导轨」还窄：条带保持最小宽、横向滚动。 */
  readonly narrow: boolean;
}

/** 位置参数既可以直接给节点，也可以按测量结果现算（窄屏提示要用到 narrow）。 */
type Slot = ReactNode | ((context: CanvasContext) => ReactNode);
const resolve = (value: Slot | undefined, context: CanvasContext): ReactNode => typeof value === "function" ? value(context) : value;

export function GraphCanvas({ label, viewportRef, className, before, after, empty, tools, floating, fitKey, children }: {
  viewportRef?: MutableRefObject<HTMLDivElement | null>;
  label: string;
  className?: string;
  /** 控制带之前的内容（如窄屏提示、下钻上下文条）。 */
  before?: Slot;
  /** 视口里画布之后的内容。 */
  after?: Slot;
  /** 没有可画的图时显示它，代替画布。 */
  empty?: ReactNode;
  /** 浮在缩放药丸里、页面自有按钮（如运行页的「跟随」）。 */
  tools?: ReactNode;
  /** 浮在画布可见区域底部居中的内容（如「回到当前节点」）：不随图滚动。 */
  floating?: ReactNode;
  /**
   * 内容身份：换运行、换起点、进出子流程时改它，画布重新做一次「适应」。
   * 同一个内容里用户自己缩放过，就不会被再次抢回去。
   */
  fitKey?: string;
  /** 画布内容：拿到条带宽度与缩放，自己决定怎么画。 */
  children: (context: CanvasContext) => ReactNode;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const viewport = viewportRef ?? own;
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  /** 用户自己缩过一次之后，自动适应就不再插手（拉起面板也不抢回去）。 */
  const manual = useRef(false);
  const [width, setWidth] = useState(0);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [stripHost, setStripHost] = useState<HTMLElement | null>(null);
  /** 正在拖动平移（给视口一个 grabbing 光标）。 */
  const [dragging, setDragging] = useState(false);

  const zoomTo = (value: number, byUser = true) => {
    if (byUser) manual.current = true;
    zoomRef.current = value;
    setZoom(value);
  };

  // 条带宽度：可用宽 = 视口 − 内边距×2 − 回环导轨。三个页面共用这一次测量。
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport]);

  // 「适应」不是一次性的：换内容、拉宽/拉窄面板都要重新量一次。
  // 左侧面板一拖，条带宽跟着变，图也该跟着回到 100%；从前只按 fitKey 适应一次，
  // 于是面板从窄拉到宽，图还停在之前算出的 90%。
  // 用户自己缩过（滚轮 / 键盘 / 药丸）之后就不再插手；换内容时重新接管。
  const key = fitKey ?? "";
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      manual.current = false;
    }
    const element = viewport.current;
    if (!element || empty) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 内容可能还没渲染出来（结构异步到达），量不到就在下一帧重试，最多几次。
    const attempt = () => {
      if (cancelled || manual.current) return;
      const value = fitZoom(element, zoomRef.current);
      if (value === null) {
        if (++tries < 8) timer = setTimeout(attempt, 60);
        return;
      }
      if (value !== zoomRef.current) {
        zoomRef.current = value;
        setZoom(value);
      }
    };
    const frame = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, empty, viewport, width]);

  // 只把量出来的尺寸交给内容：动作（适应）留在工具条里，不往渲染期塞闭包。
  const context: CanvasContext = { zoom, bandWidth: bandWidthFor(width), narrow: isNarrow(width) };

  // 按住空白处拖动 = 平移画布。卡片和按钮上的按下不拦（点击、选中都不受影响），
  // 只拦视口本身的空白；下拉框、文本也一样放行。
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, select, input, textarea, [role='listbox']")) return;
    const element = viewport.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = element.scrollLeft;
    const startTop = element.scrollTop;
    let moved = false;
    setDragging(true);
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      // 4px 死区：按下后手抖不算拖动，免得一次点击把图蹭歪。
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      element.scrollLeft = startLeft - dx;
      element.scrollTop = startTop - dy;
    };
    const stop = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
      setDragging(false);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  };

  return <div className="workflow-viewport-frame">
    {resolve(before, context)}
    {/* 下钻上下文与画布工具共用控制带，不随图缩放 */}
    <CanvasStripContext.Provider value={stripHost}>
      <div className="workflow-canvas-head">
        <div className="workflow-strip-host" ref={setStripHost} />
        <div className="workflow-canvas-tools" role="toolbar" aria-label="画布工具">
          {tools}
          <CanvasToolbar zoom={zoom} onZoom={(value) => zoomTo(value)} onFit={() => {
            const value = fitZoom(viewport.current, zoomRef.current);
            if (value !== null) zoomTo(value);
          }} />
        </div>
      </div>
      <div className="workflow-canvas-body">
        <div
          className={`workflow-viewport${dragging ? " dragging" : ""}${className ? ` ${className}` : ""}`}
          ref={viewport}
          tabIndex={0}
          aria-label={label}
          onPointerDown={onPointerDown}
          onWheel={(event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            zoomTo(clampZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1)));
          }}
          onKeyDown={(event) => {
            // 焦点在画布或任意卡片上都生效；下拉框里的按键留给下拉框。
            if (event.target instanceof HTMLSelectElement || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "+" || event.key === "=") zoomTo(clampZoom(zoom + 0.1));
            else if (event.key === "-") zoomTo(clampZoom(zoom - 0.1));
            else if (event.key === "0") zoomTo(1);
            else if (moveCardFocus(event.currentTarget, event.key, document.activeElement)) event.preventDefault();
          }}
        >
          {empty
            ? empty
            : <div className="workflow-stage" style={{ zoom }}>
              <CanvasOverlayContext.Provider value={overlayHost}>{children(context)}</CanvasOverlayContext.Provider>
            </div>}
          {resolve(after, context)}
          {!empty && floating}
        </div>
        {/* 不随图滚动、不随图缩放的一层：流程导航浮在画布右上角，不占列宽。 */}
        <div className="workflow-canvas-overlay" ref={setOverlayHost} />
      </div>
    </CanvasStripContext.Provider>
  </div>;
}
