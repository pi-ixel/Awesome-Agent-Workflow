/**
 * 流程图画布：运行页、工作流详情、AI 修改的前后对比共用一个。
 * 固定在所在区域里、画布内部滚动；Ctrl+滚轮与 +/-/0 缩放，方向键在卡片间移动；
 * 图比视口长时右缘出现小地图。工具按钮（缩放、1:1、适应）由 ZoomTools 放在各页自己的工具栏里。
 */
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Minimap } from "./Minimap.tsx";
import { readOverview, sameOverview, type Overview } from "./overview.ts";
import { moveCardFocus } from "./cardFocus.ts";
import { clampZoom, fitZoom } from "./zoom.ts";

export function GraphCanvas({ zoom, onZoom, label, viewportRef, className, before, after, empty, onMinimapJump, children }: {
  zoom: number;
  onZoom: (zoom: number) => void;
  label: string;
  /** 页面需要直接操作视口（跟随、回到当前节点、适应）时传入。 */
  viewportRef?: MutableRefObject<HTMLDivElement | null>;
  className?: string;
  /** 视口里画布之前 / 之后的内容（如窄屏提示、「回到当前节点」）。 */
  before?: ReactNode;
  after?: ReactNode;
  /** 没有可画的图时显示它，代替画布。 */
  empty?: ReactNode;
  onMinimapJump?: () => void;
  children?: ReactNode;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const viewport = viewportRef ?? own;
  const [overview, setOverview] = useState<Overview | null>(null);

  // 小地图：画布滚动、内容或尺寸变化时重新量一次（每帧最多一次）。
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readOverview(element);
        setOverview((previous) => sameOverview(previous, next) ? previous : next);
      });
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const mutations = typeof MutationObserver === "function" ? new MutationObserver(measure) : null;
    mutations?.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resize?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", measure);
      mutations?.disconnect();
      resize?.disconnect();
    };
  }, [viewport]);

  return <div className="workflow-viewport-frame">
    <div
      className={`workflow-viewport${className ? ` ${className}` : ""}`}
      ref={viewport}
      tabIndex={0}
      aria-label={label}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        onZoom(clampZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1)));
      }}
      onKeyDown={(event) => {
        // 焦点在画布或任意卡片上都生效；下拉框里的按键留给下拉框。
        if (event.target instanceof HTMLSelectElement || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "+" || event.key === "=") onZoom(clampZoom(zoom + 0.1));
        else if (event.key === "-") onZoom(clampZoom(zoom - 0.1));
        else if (event.key === "0") onZoom(1);
        else if (moveCardFocus(event.currentTarget, event.key, document.activeElement)) event.preventDefault();
      }}
    >
      {before}
      {empty ?? <div className="workflow-stage" style={{ zoom }}>{children}</div>}
      {after}
    </div>
    {overview && <Minimap overview={overview} onJump={(top, left) => {
      onMinimapJump?.();
      viewport.current?.scrollTo({ top, left });
    }} />}
  </div>;
}

/** 缩放、1:1、适应：放进所在页的工具栏。 */
export function ZoomTools({ zoom, onZoom, viewport }: { zoom: number; onZoom: (zoom: number) => void; viewport: MutableRefObject<HTMLDivElement | null> }) {
  return <>
    <span className="workflow-zoom">
      <button onClick={() => onZoom(clampZoom(zoom - 0.1))} aria-label="缩小">−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button onClick={() => onZoom(clampZoom(zoom + 0.1))} aria-label="放大">＋</button>
    </span>
    <button onClick={() => onZoom(1)} title="重置缩放">1:1</button>
    <button onClick={() => { const fit = fitZoom(viewport.current, zoom); if (fit !== null) onZoom(fit); }} title="缩放到整张流程图放得下">适应</button>
  </>;
}
