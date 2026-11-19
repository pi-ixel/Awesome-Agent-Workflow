/**
 * 流程图 + 节点详情的分屏（工作流详情、运行页共用）：
 * 面板够宽时左右分屏（详情在右），窄时上下分屏（详情在下）；中间的分隔线可以拖动，
 * 拖出来的宽 / 高按方向各记一份（本机），双击分隔线复位。没有详情时流程图占满。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ColumnResizer } from "../../../shared/ui/controls/ColumnResizer.tsx";
import { readColumnWidth, saveColumnWidth } from "../../../shared/ui/controls/columnWidth.ts";

/** 面板宽到这个值以上，详情放右侧。 */
export const SPLIT_WIDE = 700;

const SIZE = {
  wide: { key: "aaw-workflow/split-width", cssVar: "--workflow-aside-w", fallback: 360, min: 280, max: 760 },
  stacked: { key: "aaw-workflow/split-height", cssVar: "--workflow-aside-h", fallback: 320, min: 160, max: 640 },
} as const;

/** 分屏尺寸存哪（宿主存储，工作台注入）；不给时只在本次打开期间有效。 */
export const SplitStorageContext = createContext<{ getItem(key: string): string | null; setItem(key: string, value: string): void } | null>(null);

export function SplitPane({ aside, wide: forcedWide, children }: {
  /** 节点详情；为空时流程图占满。 */
  aside: ReactNode;
  /** 由调用方决定方向（运行页按面板宽度）；不给时按自己的宽度判断。 */
  wide?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const store = useContext(SplitStorageContext);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (forcedWide !== undefined) return;
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [forcedWide]);
  const wide = forcedWide ?? width >= SPLIT_WIDE;
  const size = wide ? SIZE.wide : SIZE.stacked;

  // 记住的尺寸在首帧前铺上，避免先按默认尺寸闪一下。
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !store) return;
    const saved = readColumnWidth(store, size.key);
    if (saved !== null) element.style.setProperty(size.cssVar, `${Math.min(size.max, Math.max(size.min, saved))}px`);
  }, [size, store]);

  return <div ref={root} className={`workflow-workspace ${wide ? "is-wide" : "is-stacked"}`}>
    <div className="workflow-split-main">{children}</div>
    {aside && <ColumnResizer
      axis={wide ? "x" : "y"}
      cssVarName={size.cssVar}
      rootRef={root}
      growDirection="start"
      defaultWidthPx={size.fallback}
      minPx={size.min}
      maxPx={size.max}
      label={wide ? "调整节点详情宽度" : "调整节点详情高度"}
      onCommitWidth={(value) => {
        if (store) saveColumnWidth(store, size.key, value);
      }}
    />}
    {aside && <div className="workflow-split-aside">{aside}</div>}
  </div>;
}
