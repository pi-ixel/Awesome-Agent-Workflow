import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { clampWidth } from "./columnWidth.ts";
import { useFrameTask } from "./useFrameTask.ts";

type SizeBounds = { readonly min: number; readonly max: number };

type Sizing =
  | {
      readonly cssVarName: string;
      readonly rootRef?: RefObject<HTMLElement | null>;
      readonly readWidth?: never;
      readonly onPreviewWidth?: never;
    }
  | {
      readonly cssVarName?: never;
      readonly rootRef?: never;
      readonly readWidth: () => number;
      readonly onPreviewWidth: (width: number) => void;
    };

export type ColumnResizerProps = Sizing & {
  readonly defaultWidthPx: number;
  readonly minPx: number;
  readonly maxPx: number;
  readonly readBounds?: () => SizeBounds;
  readonly paneRef?: RefObject<HTMLElement | null>;
  readonly onCommitWidth?: (width: number) => void;
  readonly onDraggingChange?: (dragging: boolean) => void;
  readonly onReset?: () => void;
  readonly cancelBehavior?: "commit" | "revert";
  readonly growDirection: "end" | "start";
  readonly label: string;
  readonly hint?: string;
  readonly axis?: "x" | "y";
  readonly placement?: "flow" | "overlay" | "seam";
};

function root(props: ColumnResizerProps) {
  return props.rootRef ? props.rootRef.current : document.documentElement;
}

function bounds(props: ColumnResizerProps) {
  return props.readBounds?.() ?? { min: props.minPx, max: props.maxPx };
}

function readWidth(props: ColumnResizerProps) {
  if (props.readWidth) return props.readWidth();
  const width = Number.parseFloat(
    root(props)?.style.getPropertyValue(props.cssVarName) ?? "",
  );
  return Number.isFinite(width) && width > 0 ? width : props.defaultWidthPx;
}

function previewWidth(props: ColumnResizerProps, width: number) {
  if (props.onPreviewWidth) props.onPreviewWidth(width);
  else root(props)?.style.setProperty(props.cssVarName, `${width}px`);
}

function syncRange(
  divider: HTMLElement,
  props: ColumnResizerProps,
  width = readWidth(props),
) {
  const { min, max } = bounds(props);
  divider.setAttribute("aria-valuemin", String(min));
  divider.setAttribute("aria-valuemax", String(max));
  divider.setAttribute("aria-valuenow", String(clampWidth(width, min, max)));
}

/** 分隔线统一处理指针、键盘、焦点与预览。宽度布局和持久化由所属面板提供。 */
export function ColumnResizer(props: ColumnResizerProps) {
  const {
    label,
    hint,
    minPx,
    maxPx,
    paneRef,
    axis = "x",
    placement = "flow",
    growDirection,
  } = props;
  const vertical = axis === "y";
  const divider = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const stopDrag = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useFrameTask();

  useLayoutEffect(() => {
    current.current = props;
    if (divider.current && !stopDrag.current) syncRange(divider.current, props);
  });

  useEffect(() => {
    const pane = paneRef?.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (divider.current) syncRange(divider.current, current.current);
    });
    observer.observe(pane);
    if (pane.parentElement) observer.observe(pane.parentElement);
    return () => observer.disconnect();
  }, [paneRef]);

  useEffect(() => () => stopDrag.current?.(), []);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || stopDrag.current)
      return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    if (Number.isFinite(pointerId)) handle.setPointerCapture?.(pointerId);
    const offset = (event: PointerEvent) =>
      vertical ? event.clientY : event.clientX;
    const origin = offset(event.nativeEvent);
    const initial = readWidth(props);
    let width = initial;
    let resized = false;
    const selection = document.body.style.getPropertyValue("user-select");
    const priority = document.body.style.getPropertyPriority("user-select");
    document.body.style.setProperty("user-select", "none");
    const apply = (next: number) => {
      previewWidth(current.current, next);
      syncRange(handle, current.current, next);
    };
    const measure = (event: PointerEvent) => {
      const { min, max } = bounds(current.current);
      const delta =
        (offset(event) - origin) * (growDirection === "end" ? 1 : -1);
      return clampWidth(initial + delta, min, max);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      width = measure(event);
      if (!resized && width === initial) return;
      resized = true;
      frame.schedule(() => apply(width));
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", finish);
      handle.removeEventListener("lostpointercapture", lost);
      frame.cancel();
      stopDrag.current = null;
      if (selection)
        document.body.style.setProperty("user-select", selection, priority);
      else document.body.style.removeProperty("user-select");
    };
    const finish = () => {
      detach();
      if (resized || width !== initial) {
        apply(width);
        current.current.onCommitWidth?.(width);
      }
      setDragging(false);
      current.current.onDraggingChange?.(false);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (Number.isFinite(pointerId)) width = measure(event);
      finish();
    };
    const lost = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (current.current.cancelBehavior !== "revert") {
        finish();
        return;
      }
      detach();
      if (resized) apply(initial);
      setDragging(false);
      current.current.onDraggingChange?.(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", finish);
    handle.addEventListener("lostpointercapture", lost);
    stopDrag.current = () => {
      detach();
      current.current.onDraggingChange?.(false);
    };
    setDragging(true);
    props.onDraggingChange?.(true);
  };

  const commit = (width: number) => {
    previewWidth(props, width);
    if (divider.current) syncRange(divider.current, props, width);
    props.onCommitWidth?.(width);
  };
  const position =
    placement === "overlay"
      ? "absolute inset-y-0 -left-1 z-10 w-2"
      : placement === "seam"
        ? "relative z-10 h-full w-px bg-line before:absolute before:inset-y-0 before:-left-1 before:w-[9px] before:content-['']"
        : vertical
          ? "relative h-1 w-full"
          : "relative h-full w-1";
  const indicator = vertical
    ? `inset-x-2 h-0.5 ${growDirection === "end" ? "top-0" : "bottom-0"}`
    : `inset-y-2 w-0.5 ${placement !== "flow" ? "left-1/2 -translate-x-1/2" : growDirection === "end" ? "left-0" : "right-0"}`;

  return (
    <div
      ref={divider}
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuemin={minPx}
      aria-valuemax={maxPx}
      tabIndex={0}
      data-hint={hint}
      data-resizing={dragging || undefined}
      onPointerDown={start}
      onDoubleClick={props.onReset ?? (() => commit(props.defaultWidthPx))}
      onKeyDown={(event) => {
        const decrease = vertical ? "ArrowUp" : "ArrowLeft";
        const increase = vertical ? "ArrowDown" : "ArrowRight";
        if (
          ![decrease, increase, "Home", "End"].includes(event.key) ||
          stopDrag.current
        )
          return;
        event.preventDefault();
        const { min, max } = bounds(props);
        const step =
          (event.key === increase ? 16 : -16) *
          (growDirection === "end" ? 1 : -1);
        const width =
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : clampWidth(readWidth(props) + step, min, max);
        commit(width);
      }}
      className={`group flex shrink-0 touch-none items-stretch outline-none ${position} ${vertical ? "cursor-ns-resize" : "cursor-ew-resize"}`}
    >
      <span
        aria-hidden={true}
        className={`pointer-events-none absolute rounded-pill bg-focus-ring opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[resizing=true]:opacity-100 ${indicator}`}
      />
    </div>
  );
}
