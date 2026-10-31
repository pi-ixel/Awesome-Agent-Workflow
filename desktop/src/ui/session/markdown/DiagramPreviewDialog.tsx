// Viewport geometry and gestures adapted from ZCode's diagram-preview-dialog.
// 有意偏离：滚轮一律缩放（ZCode 是普通滚轮平移、ctrl+滚轮缩放）——滚轮缩放、
// 拖拽平移、捏合缩放（用户定稿）。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, XIcon } from "../../icons.tsx";
import {
  fitDiagramToViewport,
  panDiagram,
  zoomDiagramAtPoint,
  type DiagramPoint,
  type DiagramViewportBounds,
  type DiagramViewportTransform,
} from "./diagramViewport.ts";
type PinchGestureState = {
  center: DiagramPoint;
  distance: number;
  transform: DiagramViewportTransform;
};

const defaultTransform: DiagramViewportTransform = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

const zoomScaleOptions = [0.5, 1, 2] as const;

const svgGraphicSelector = [
  "circle",
  "ellipse",
  "foreignObject",
  "g",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
].join(",");
const nonVisibleSvgAncestorSelector = [
  "clipPath",
  "defs",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "pattern",
  "radialGradient",
  "script",
  "style",
  "symbol",
  "title",
].join(",");

function getPointerCenter(points: PointerEvent[]): DiagramPoint {
  const [first, second] = points;
  if (!first || !second) {
    return { x: first?.clientX ?? 0, y: first?.clientY ?? 0 };
  }

  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

function getPointerDistance(points: PointerEvent[]): number {
  const [first, second] = points;
  if (!first || !second) {
    return 0;
  }

  return Math.hypot(
    first.clientX - second.clientX,
    first.clientY - second.clientY,
  );
}

function isTransparentPaint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "none" ||
    normalized === "transparent" ||
    normalized === "rgba(0, 0, 0, 0)"
  );
}

function readRootSvgBounds(svgElement: SVGSVGElement): DiagramViewportBounds {
  const viewBox = svgElement.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return {
      height: viewBox.height,
      width: viewBox.width,
      x: viewBox.x,
      y: viewBox.y,
    };
  }

  const width = svgElement.width.baseVal.value;
  const height = svgElement.height.baseVal.value;
  if (width > 0 && height > 0) {
    return { height, width };
  }

  return {
    height: svgElement.clientHeight,
    width: svgElement.clientWidth,
  };
}

function applyPreviewSvgLayout(
  contentElement: HTMLDivElement,
  svgElement: SVGSVGElement,
): DiagramViewportBounds {
  const rootBounds = readRootSvgBounds(svgElement);
  if (rootBounds.width > 0 && rootBounds.height > 0) {
    // Mermaid 输出的 SVG 常见为 width="100%" + max-width=viewBox 宽度。
    // transform 实际作用在父级 content 上；如果只改 SVG，父级仍可能保持 300px 级别的收缩宽度。
    // 因此父级和 SVG 都要对齐到 viewBox 尺寸，保证 fit 计算和 CSS transform 使用同一个坐标系。
    contentElement.style.width = `${rootBounds.width}px`;
    contentElement.style.height = `${rootBounds.height}px`;
    svgElement.style.width = "100%";
    svgElement.style.height = "100%";
    svgElement.style.maxWidth = "none";
  }

  return rootBounds;
}

function mergeBounds(
  current: DiagramViewportBounds | null,
  box: Pick<DOMRect, "height" | "width" | "x" | "y">,
): DiagramViewportBounds {
  if (!current) {
    return {
      height: box.height,
      width: box.width,
      x: box.x,
      y: box.y,
    };
  }

  const minX = Math.min(current.x ?? 0, box.x);
  const minY = Math.min(current.y ?? 0, box.y);
  const maxX = Math.max((current.x ?? 0) + current.width, box.x + box.width);
  const maxY = Math.max((current.y ?? 0) + current.height, box.y + box.height);

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY,
  };
}

function isCanvasBackgroundElement(
  element: SVGGraphicsElement,
  box: DOMRect,
  rootBounds: DiagramViewportBounds,
): boolean {
  if (
    element.tagName.toLowerCase() !== "rect" ||
    rootBounds.width <= 0 ||
    rootBounds.height <= 0
  ) {
    return false;
  }

  const style = getComputedStyle(element);
  const className = element.getAttribute("class") ?? "";
  const coversRoot =
    Math.abs(box.x - (rootBounds.x ?? 0)) <= 1 &&
    Math.abs(box.y - (rootBounds.y ?? 0)) <= 1 &&
    box.width >= rootBounds.width * 0.95 &&
    box.height >= rootBounds.height * 0.95;

  return (
    coversRoot &&
    (isTransparentPaint(style.stroke) || className.includes("background"))
  );
}

function resolveSvgBounds(
  svgElement: SVGSVGElement | null,
): DiagramViewportBounds {
  if (!svgElement) {
    return { height: 0, width: 0 };
  }

  const rootBounds = readRootSvgBounds(svgElement);
  let visibleBounds: DiagramViewportBounds | null = null;

  for (const element of svgElement.querySelectorAll(svgGraphicSelector)) {
    if (!(element instanceof SVGGraphicsElement)) {
      continue;
    }
    if (element.closest(nonVisibleSvgAncestorSelector)) {
      continue;
    }

    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      continue;
    }

    try {
      const box = element.getBBox();
      if (
        box.width <= 0 ||
        box.height <= 0 ||
        isCanvasBackgroundElement(element, box, rootBounds)
      ) {
        continue;
      }
      // 嵌套 g/foreignObject 的 bbox 使用局部坐标，先转回根 SVG 坐标再合并。
      // 否则 fit 后图形会偏向一侧，甚至超出预览视口。
      const rootMatrix = svgElement.getScreenCTM();
      const elementMatrix = element.getScreenCTM();
      if (rootMatrix && elementMatrix) {
        const matrix = rootMatrix.inverse().multiply(elementMatrix);
        const corners = [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x, box.y + box.height],
          [box.x + box.width, box.y + box.height],
        ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
        const xs = corners.map((point) => point.x),
          ys = corners.map((point) => point.y);
        visibleBounds = mergeBounds(visibleBounds, {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        });
      } else {
        visibleBounds = mergeBounds(visibleBounds, box);
      }
    } catch {
      // 某些 SVG 元素未完成布局时不能读取 bbox；继续用其余可见图形求 union。
    }
  }

  if (visibleBounds && visibleBounds.width > 0 && visibleBounds.height > 0) {
    return visibleBounds;
  }

  try {
    const box = svgElement.getBBox();
    if (box.width > 0 && box.height > 0) {
      return {
        height: box.height,
        width: box.width,
        x: box.x,
        y: box.y,
      };
    }
  } catch {
    // 根 bbox 不可用时回退到 viewBox / 声明尺寸。
  }

  return rootBounds;
}

function getViewportPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number,
): DiagramPoint {
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export function DiagramPreviewDialog({
  open,
  onClose,
  svg,
}: {
  open: boolean;
  onClose: () => void;
  svg: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activePointersRef = useRef(new Map<number, PointerEvent>());
  const dragOriginRef = useRef<{
    point: DiagramPoint;
    transform: DiagramViewportTransform;
  } | null>(null);
  const pinchGestureRef = useRef<PinchGestureState | null>(null);
  const [transform, setTransform] =
    useState<DiagramViewportTransform>(defaultTransform);

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const svgElement = content?.querySelector("svg");
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    const diagramBounds = resolveSvgBounds(svgElement);
    const viewportRect = viewport.getBoundingClientRect();
    const nextTransform = fitDiagramToViewport({
      diagramHeight: diagramBounds.height,
      diagramWidth: diagramBounds.width,
      diagramX: (diagramBounds.x ?? 0) - (rootBounds.x ?? 0),
      diagramY: (diagramBounds.y ?? 0) - (rootBounds.y ?? 0),
      viewportHeight: viewportRect.height,
      viewportWidth: viewportRect.width,
    });

    setTransform(nextTransform);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    setTransform((current) =>
      zoomDiagramAtPoint(current, center, current.scale * factor),
    );
  }, []);

  const zoomToScale = useCallback((scale: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    setTransform((current) => zoomDiagramAtPoint(current, center, scale));
  }, []);

  const reset = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const svgElement = content?.querySelector("svg");
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    const diagramBounds = resolveSvgBounds(svgElement);
    const viewportRect = viewport.getBoundingClientRect();
    setTransform({
      scale: 1,
      translateX:
        (viewportRect.width - diagramBounds.width) / 2 -
        ((diagramBounds.x ?? 0) - (rootBounds.x ?? 0)),
      translateY:
        (viewportRect.height - diagramBounds.height) / 2 -
        ((diagramBounds.y ?? 0) - (rootBounds.y ?? 0)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      activePointersRef.current.clear();
      dragOriginRef.current = null;
      pinchGestureRef.current = null;
      return;
    }

    const frame = window.requestAnimationFrame(fitToViewport);
    return () => window.cancelAnimationFrame(frame);
  }, [fitToViewport, open, svg]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleResize = () => fitToViewport();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [fitToViewport, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(1.18);
        return;
      }

      if (event.key === "-") {
        event.preventDefault();
        zoomBy(0.85);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, zoomBy]);

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // 滚轮一律以光标为锚点缩放（有意偏离 ZCode 的「普通滚轮平移」）；
    // ctrl+wheel 保留同路径——触控板捏合发的就是 ctrl+wheel。平移走拖拽。
    const point = getViewportPoint(viewport, event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.01);
    setTransform((current) =>
      zoomDiagramAtPoint(current, point, current.scale * factor),
    );
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, event.nativeEvent);
      const activePointers = Array.from(activePointersRef.current.values());

      if (activePointers.length >= 2) {
        pinchGestureRef.current = {
          center: getPointerCenter(activePointers),
          distance: getPointerDistance(activePointers),
          transform,
        };
        dragOriginRef.current = null;
        return;
      }

      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      dragOriginRef.current = { point, transform };
    },
    [transform],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport || !activePointersRef.current.has(event.pointerId)) {
        return;
      }

      activePointersRef.current.set(event.pointerId, event.nativeEvent);
      const activePointers = Array.from(activePointersRef.current.values());

      if (activePointers.length >= 2 && pinchGestureRef.current) {
        const nextCenter = getPointerCenter(activePointers);
        const nextDistance = getPointerDistance(activePointers);
        const gesture = pinchGestureRef.current;
        const viewportCenter = getViewportPoint(
          viewport,
          nextCenter.x,
          nextCenter.y,
        );
        const panDelta = {
          x: nextCenter.x - gesture.center.x,
          y: nextCenter.y - gesture.center.y,
        };
        const nextScale =
          gesture.transform.scale *
          (gesture.distance > 0 ? nextDistance / gesture.distance : 1);
        const zoomed = zoomDiagramAtPoint(
          gesture.transform,
          viewportCenter,
          nextScale,
        );
        setTransform(panDiagram(zoomed, panDelta));
        return;
      }

      if (dragOriginRef.current) {
        const point = getViewportPoint(viewport, event.clientX, event.clientY);
        setTransform(
          panDiagram(dragOriginRef.current.transform, {
            x: point.x - dragOriginRef.current.point.x,
            y: point.y - dragOriginRef.current.point.y,
          }),
        );
      }
    },
    [],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      activePointersRef.current.delete(event.pointerId);
      dragOriginRef.current = null;
      pinchGestureRef.current = null;
    },
    [],
  );

  const transformStyle = useMemo(
    () => ({
      transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`,
    }),
    [transform],
  );

  const zoomPercent = Math.round(transform.scale * 100);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!open || !viewport) return;
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [open, handleWheel]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab") {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, select, [tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0]!,
          last = nodes[nodes.length - 1]!;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey, true);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Mermaid 图表"
        tabIndex={-1}
        className="flex h-[100dvh] w-screen flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl outline-none sm:h-[86vh] sm:w-[90vw]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3 text-ui-base">
          <span className="font-medium text-ink">Mermaid 图表</span>
          <div className="flex items-center gap-1">
            <PreviewButton label="缩小" onClick={() => zoomBy(0.85)}>
              <CircleIcon minus />
            </PreviewButton>
            <div className="relative">
              <button
                type="button"
                aria-label="缩放比例"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
                className="flex h-8 min-w-14 items-center justify-center gap-1 rounded px-1.5 font-mono text-ui-sm text-ink-mute hover:bg-raised"
              >
                {zoomPercent}%<ChevronDownIcon className="size-3" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  aria-label="图表缩放"
                  className="absolute right-0 top-full z-10 min-w-36 rounded-lg border border-line bg-surface p-1 text-ui-base shadow-lg"
                >
                  {zoomScaleOptions.map((scale) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={scale}
                      className="block w-full rounded px-2 py-1 text-left hover:bg-raised"
                      onClick={() => {
                        zoomToScale(scale);
                        setMenuOpen(false);
                      }}
                    >
                      {Math.round(scale * 100)}%
                    </button>
                  ))}
                  <div className="my-1 border-t border-line" />
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full rounded px-2 py-1 text-left hover:bg-raised"
                    onClick={() => {
                      fitToViewport();
                      setMenuOpen(false);
                    }}
                  >
                    适应窗口
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full rounded px-2 py-1 text-left hover:bg-raised"
                    onClick={() => {
                      reset();
                      setMenuOpen(false);
                    }}
                  >
                    重置缩放
                  </button>
                </div>
              )}
            </div>
            <PreviewButton label="放大" onClick={() => zoomBy(1.18)}>
              <CircleIcon />
            </PreviewButton>
            <PreviewButton label="关闭" onClick={onClose}>
              <XIcon className="size-3.5" />
            </PreviewButton>
          </div>
        </div>
        <div
          ref={viewportRef}
          data-diagram-viewport=""
          className="relative min-h-0 flex-1 touch-none overflow-hidden bg-surface cursor-grab active:cursor-grabbing"
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
        >
          <div
            ref={contentRef}
            aria-label="Mermaid 图表内容"
            className="absolute left-0 top-0 origin-top-left select-none [&_svg]:block [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            style={transformStyle}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
function CircleIcon({ minus = false }: { minus?: boolean }) {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
      {!minus && <path d="M12 8v8" />}
    </svg>
  );
}
function PreviewButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded text-ink-mute hover:bg-raised hover:text-ink"
    >
      {children}
    </button>
  );
}
