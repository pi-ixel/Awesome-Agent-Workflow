import { Callout } from "../../../shared/ui/Callout.tsx";
/**
 * Toast 宿主：右下角浮层栈（避开底部居中的输入区），每条自带定时退场。
 *
 * - 定时器在条目组件内（store 保持无副作用）；
 * - `durationMs: 0` 的条目不装定时器（持续到显式关闭的进度态）；
 * - 悬停或键盘焦点在通知栈内时暂停退场，离开后按剩余时长续走；
 * - aria-live="polite"：屏幕阅读器在空闲时播报，不打断当前任务。
 */
import { useContext, useEffect, useRef, type RefObject } from "react";

import type { ToastItem } from "../feedback/types.ts";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { WorkbenchContext } from "./bindings/react.ts";

function ToastEntry({
  item,
  dismiss,
  hostRef,
}: {
  readonly item: ToastItem;
  readonly dismiss: (id: number) => void;
  readonly hostRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    if (item.durationMs === 0) return;
    const host = hostRef.current;
    if (!host) return;
    let remaining = item.durationMs;
    let startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => dismiss(item.id),
      remaining,
    );
    const pause = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining -= Date.now() - startedAt;
    };
    const resume = (): void => {
      if (timer !== null) return;
      startedAt = Date.now();
      timer = setTimeout(() => dismiss(item.id), Math.max(0, remaining));
    };
    let hovered = host.matches(":hover");
    const sync = () => {
      if (hovered || host.contains(document.activeElement)) pause();
      else resume();
    };
    const onEnter = () => {
      hovered = true;
      pause();
    };
    const onLeave = () => {
      hovered = false;
      sync();
    };
    const onBlur = (event: FocusEvent) => {
      if (
        !hovered &&
        !(
          event.relatedTarget instanceof Node &&
          host.contains(event.relatedTarget)
        )
      )
        resume();
    };
    const observer = new MutationObserver(sync);
    observer.observe(host, { childList: true });
    host.addEventListener("pointerenter", onEnter);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("focusin", pause);
    host.addEventListener("focusout", onBlur);
    sync();
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("focusin", pause);
      host.removeEventListener("focusout", onBlur);
    };
  }, [item.id, item.durationMs, dismiss, hostRef]);

  return (
    <Callout
      floating
      role="status"
      tone={item.variant === "info" ? "neutral" : item.variant}
      title={item.message}
      onDismiss={() => dismiss(item.id)}
      className="toast-in pointer-events-auto max-w-[min(100%,24rem)] shadow-floating"
    />
  );
}

const noToasts: readonly ToastItem[] = [];

/** 挂在应用根：无条目时零占位。 */
export function ToastHost() {
  const workbench = useContext(WorkbenchContext);
  const items = useRegisteredSnapshot(
    workbench?.toasts,
    (state) => state?.items ?? noToasts,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (!workbench || items.length === 0) {
    return null;
  }
  return (
    <div
      ref={hostRef}
      data-toast-host=""
      aria-live="polite"
      className="pointer-events-none fixed right-5 bottom-5 z-[60] flex max-w-[calc(100%-2.5rem)] flex-col items-end gap-2"
    >
      {items.map((item) => (
        <ToastEntry
          key={item.id}
          item={item}
          dismiss={workbench.dismissToast}
          hostRef={hostRef}
        />
      ))}
    </div>
  );
}
