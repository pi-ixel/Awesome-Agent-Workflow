import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlanEntry } from "../../acp/types.ts";
import type { TaskProgressSummary } from "../../core/sessionStatusModel.ts";

function TaskRows({ entries }: { entries: readonly PlanEntry[] }) {
  return (
    <ol className="space-y-2">
      {entries.map((entry, index) => (
        <li key={index} className="flex items-start gap-2 text-sm leading-5">
          <span
            aria-label={
              entry.status === "completed"
                ? "已完成"
                : entry.status === "in_progress"
                  ? "进行中"
                  : "待办"
            }
            className={
              entry.status === "completed"
                ? "text-ok-ink"
                : entry.status === "in_progress"
                  ? "text-info"
                  : "text-ink-faint"
            }
          >
            {entry.status === "completed"
              ? "✓"
              : entry.status === "in_progress"
                ? "●"
                : "○"}
          </span>
          <span
            title={entry.content}
            className={`line-clamp-2 min-w-0 break-words ${entry.status === "completed" ? "text-ink-faint line-through" : "text-ink-soft"}`}
          >
            {entry.content}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 长计划使用三项焦点窗口，隐藏组支持鼠标、键盘和触屏预览。 */
export function StatusTaskProgress({ model }: { model: TaskProgressSummary }) {
  const [open, setOpen] = useState<"before" | "after" | null>(null);
  const beforeRef = useRef<HTMLButtonElement>(null),
    afterRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280 });
  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current);
  };
  const schedule = (value: typeof open, delay: number): void => {
    cancel();
    timer.current = setTimeout(() => setOpen(value), delay);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = open === "before" ? beforeRef.current : afterRef.current;
    if (!trigger) return;
    const update = (): void => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(280, Math.max(180, window.innerWidth - 24));
      const height = popupRef.current?.offsetHeight ?? 200;
      const left =
        rect.left >= width + 16
          ? rect.left - width - 8
          : Math.min(window.innerWidth - width - 12, Math.max(12, rect.left));
      const preferredTop = rect.left >= width + 16 ? rect.top : rect.bottom + 8;
      setPosition({
        left,
        top: Math.max(
          12,
          Math.min(preferredTop, window.innerHeight - height - 12),
        ),
        width,
      });
    };
    update();
    // 右栏挤窄聊天容器也会触发自动收起，不一定伴随 window.resize。
    // 预览通过 portal 绘制，触发项消失时要主动收口。
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!trigger.getClientRects().length) setOpen(null);
            else update();
          });
    observer?.observe(trigger);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !trigger.contains(event.target) &&
        !popupRef.current?.contains(event.target)
      )
        setOpen(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const group = (side: "before" | "after", entries: readonly PlanEntry[]) => {
    if (!entries.length) return null;
    const allDone = entries.every((entry) => entry.status === "completed");
    const label = allDone
      ? `已完成 ${entries.length} 项`
      : `${side === "before" ? "前面" : "后面"} ${entries.length} 项`;
    return (
      <button
        ref={side === "before" ? beforeRef : afterRef}
        type="button"
        aria-expanded={open === side}
        className="w-full rounded px-2 py-1 text-left text-sm text-ink-faint hover:bg-raised focus-visible:outline-2 focus-visible:outline-info"
        onMouseEnter={() => schedule(side, 120)}
        onMouseLeave={() => schedule(null, 80)}
        onFocus={() => {
          cancel();
          setOpen(side);
        }}
        onBlur={(event) => {
          if (!popupRef.current?.contains(event.relatedTarget))
            schedule(null, 80);
        }}
        onClick={() => {
          cancel();
          setOpen(side);
        }}
      >
        {label} ›
      </button>
    );
  };
  const hidden =
    open === "before"
      ? model.entries.slice(0, model.start)
      : model.entries.slice(model.end);
  return (
    <div>
      {group("before", model.entries.slice(0, model.start))}
      <div className="px-2 py-1">
        <TaskRows entries={model.entries.slice(model.start, model.end)} />
      </div>
      {group("after", model.entries.slice(model.end))}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            role="tooltip"
            aria-label="隐藏任务步骤"
            className="fixed z-50 max-h-[min(70dvh,20rem)] overflow-auto rounded-xl border border-line-strong bg-surface p-3 shadow-xl"
            style={position}
            onMouseEnter={cancel}
            onMouseLeave={() => schedule(null, 80)}
          >
            <TaskRows entries={hidden} />
          </div>,
          document.body,
        )}
    </div>
  );
}
