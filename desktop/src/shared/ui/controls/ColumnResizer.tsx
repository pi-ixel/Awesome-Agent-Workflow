/**
 * 三栏可拖拽调宽（开发页三栏布局）：
 *
 * - 4px 宽竖向拖拽热区（hover / 拖拽中高亮 accent，cursor-col-resize）；
 * - 拖拽实时更新指定 CSS 变量（挂在 documentElement 上，供 App 的
 *   grid-template-columns 引用），结束时通知调用方保存；
 * - 双击热区恢复默认宽度；
 * - 拖拽期间给 body 加 user-select:none，避免划选沿途文字。
 *
 * 本组件只负责「一条竖向分隔线」的交互，不感知布局结构；左右栏各挂
 * 一个，方向相反（左栏往右拖增宽，右栏往左拖增宽）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useFrameTask } from "./useFrameTask.ts";
import { clampWidth } from "./columnWidth.ts";

export interface ColumnResizerProps {
  /** 要更新的 CSS 变量名（如 LEFT_WIDTH_VAR）。 */
  readonly cssVarName: string;
  readonly rootRef?: RefObject<HTMLElement | null>;
  readonly onCommitWidth?: (width: number) => void;
  /** 默认宽度（双击复位的目标值），也作为无 CSS 变量时的拖拽基准。 */
  readonly defaultWidthPx: number;
  readonly minPx: number;
  readonly maxPx: number;
  /** 增宽方向：end=向右拖增宽（左栏），start=向左拖增宽（右栏）。 */
  readonly growDirection: "end" | "start";
  /** 无障碍名称（role=separator 的 aria-label）。 */
  readonly label: string;
}

/** 一次拖拽会话的现场（起点指针位置 / 起始宽度 / 最新宽度）。 */
interface DragSession {
  startX: number;
  startWidth: number;
  lastWidth: number;
}

export function ColumnResizer({
  cssVarName,
  rootRef,
  onCommitWidth,
  defaultWidthPx,
  minPx,
  maxPx,
  growDirection,
  label,
}: ColumnResizerProps) {
  // 拖拽中高亮 + 决定全局指针监听是否挂载
  const [isDragging, setIsDragging] = useState(false);
  // 拖拽会话现场用 ref 持有：pointermove 高频触发，不走 state 重渲染
  const dragSessionRef = useRef<DragSession | null>(null);
  const resizeFrame = useFrameTask();
  const readWidth = useCallback(() => {
    const root = rootRef ? rootRef.current : document.documentElement;
    const width = Number.parseFloat(root?.style.getPropertyValue(cssVarName) ?? "");
    return Number.isFinite(width) && width > 0 ? width : defaultWidthPx;
  }, [cssVarName, defaultWidthPx, rootRef]);
  const previewWidth = useCallback((width: number) => {
    const root = rootRef ? rootRef.current : document.documentElement;
    root?.style.setProperty(cssVarName, `${width}px`);
  }, [cssVarName, rootRef]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const startWidth = clampWidth(
        readWidth(),
        minPx,
        maxPx,
      );
      dragSessionRef.current = {
        startX: event.clientX,
        startWidth,
        lastWidth: startWidth,
      };
      setIsDragging(true);
      // 拖拽期间禁文字划选（收口时移除）
      document.body.style.setProperty("user-select", "none");
      event.preventDefault();
    },
    [readWidth, minPx, maxPx],
  );

  // 拖拽中的全局指针监听：指针移出热区后仍持续跟手，收口即持久化
  useEffect(() => {
    if (!isDragging) {
      return;
    }
    function handlePointerMove(event: PointerEvent): void {
      const session = dragSessionRef.current;
      if (session === null) {
        return;
      }
      const delta =
        growDirection === "end"
          ? event.clientX - session.startX
          : session.startX - event.clientX;
      const next = clampWidth(session.startWidth + delta, minPx, maxPx);
      session.lastWidth = next;
      resizeFrame.schedule(() => previewWidth(next));
    }
    function finishDrag(): void {
      const session = dragSessionRef.current;
      if (session === null) {
        return;
      }
      resizeFrame.flush();
      onCommitWidth?.(session.lastWidth);
      dragSessionRef.current = null;
      setIsDragging(false);
      document.body.style.removeProperty("user-select");
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      window.removeEventListener("blur", finishDrag);
      resizeFrame.cancel();
      document.body.style.removeProperty("user-select");
    };
  }, [
    growDirection,
    isDragging,
    maxPx,
    minPx,
    onCommitWidth,
    previewWidth,
    resizeFrame,
  ]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      aria-valuemin={minPx}
      aria-valuemax={maxPx}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const delta =
          (event.key === "ArrowRight" ? 16 : -16) *
          (growDirection === "end" ? 1 : -1);
        const next =
          event.key === "Home"
            ? minPx
            : event.key === "End"
              ? maxPx
              : clampWidth(
                  readWidth() + delta,
                  minPx,
                  maxPx,
                );
        previewWidth(next);
        onCommitWidth?.(next);
      }}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => {
        previewWidth(defaultWidthPx);
        onCommitWidth?.(defaultWidthPx);
      }}
      className="group relative flex h-full w-1 shrink-0 cursor-ew-resize touch-none items-stretch bg-transparent outline-none"
    >
      {/* 指示条(ZCode separator after 形态,WorkspaceShellLayout.tsx:2313-2335):
          2px 圆头短棒、上下内缩(inset-y-2)、foreground-subtlest/50 灰,
          常态 opacity-0,hover / 键盘聚焦 / 拖拽同色淡入——只动透明度,
          无宽度跳变。钉在真实栏界(左栏 = 热区左缘,右栏 = 热区右缘),
          不存在错位。 */}
      <span
        aria-hidden={true}
        className={`pointer-events-none absolute inset-y-2 w-0.5 rounded-full bg-ink-subtlest/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${
          isDragging ? "opacity-100" : ""
        } ${growDirection === "end" ? "left-0" : "right-0"}`}
      />
    </div>
  );
}
