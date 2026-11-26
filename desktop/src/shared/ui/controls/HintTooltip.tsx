/**
 * One themed text hint per Desktop window. Mark an existing element with
 * data-hint to preserve its layout, focus behavior, and event handlers.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HintSurface } from "./HintSurface.tsx";

const selector = "[data-hint]";
const hoverDelay = 250;
const margin = 8;
const gap = 6;

export function hintTooltipProps(label: string | undefined) {
  return { "data-hint": label };
}

function anchorOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

export function HintTooltip() {
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ anchor: HTMLElement; label: string } | null>(null);
  useLayoutEffect(() => {
    const card = surface.current;
    if (!tooltip || !card) return;
    const { anchor, label } = tooltip;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = card.getBoundingClientRect();
    const centered = rect.left + (rect.width - width) / 2;
    const top = rect.top - height - gap;
    const below = rect.bottom + gap;
    card.style.left = `${Math.max(margin, Math.min(centered, window.innerWidth - width - margin))}px`;
    card.style.top = `${Math.max(margin, Math.min(top >= margin ? top : below, window.innerHeight - height - margin))}px`;
    const existing = anchor.getAttribute("aria-describedby");
    const alreadyDescribed =
      anchor.getAttribute("aria-label") === label ||
      existing?.split(/\s+/).some(
        (description) => document.getElementById(description)?.textContent?.trim() === label.trim(),
      );
    if (alreadyDescribed) return;
    anchor.setAttribute("aria-describedby", existing ? `${existing} ${id}` : id);
    return () => {
      const descriptions = (anchor.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((description) => description && description !== id);
      if (descriptions.length) anchor.setAttribute("aria-describedby", descriptions.join(" "));
      else anchor.removeAttribute("aria-describedby");
    };
  }, [id, tooltip]);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let shown = false;
    let timer: number | undefined;
    let observer: MutationObserver | undefined;

    const clear = () => {
      window.clearTimeout(timer);
      timer = undefined;
      observer?.disconnect();
      observer = undefined;
      shown = false;
      anchor = null;
    };
    const dismiss = () => {
      clear();
      setTooltip(null);
    };

    const show = () => {
      const target = anchor;
      const label = target?.dataset.hint;
      if (!target?.isConnected || !label?.trim()) {
        dismiss();
        return;
      }

      shown = true;
      setTooltip({ anchor: target, label });

      observer = new MutationObserver(() => {
        if (!target.isConnected || target.dataset.hint !== label) dismiss();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      observer.observe(target, { attributes: true, attributeFilter: ["data-hint"] });
    };

    const open = (target: HTMLElement | null, delay: number) => {
      if (target === anchor && (shown || delay > 0)) return;
      dismiss();
      if (!target?.dataset.hint?.trim()) return;
      anchor = target;
      if (delay === 0) show();
      else timer = window.setTimeout(show, delay);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = anchorOf(event.target);
      if (target !== anchorOf(event.relatedTarget))
        open(
          target?.hasAttribute("data-hint-focus-only") ? null : target,
          hoverDelay,
        );
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      if (anchor && anchorOf(event.target) === anchor && anchorOf(event.relatedTarget) !== anchor)
        dismiss();
    };
    const focus = (event: FocusEvent) => open(anchorOf(event.target), 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };

    document.addEventListener("pointerover", pointerOver, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("click", dismiss, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clear();
      document.removeEventListener("pointerover", pointerOver, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  return createPortal(
    <HintSurface
      surfaceKind="text"
      open={tooltip !== null}
      ref={surface}
      id={id}
      className="pointer-events-none fixed z-[110] w-max max-w-[min(20rem,calc(100vw_-_1rem))] whitespace-pre-wrap wrap-anywhere px-3 py-1.5 text-xs leading-snug"
    >
      {tooltip?.label}
    </HintSurface>,
    document.body,
  );
}
